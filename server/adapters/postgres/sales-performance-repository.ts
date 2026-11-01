import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { CrmRole } from '../../core/auth';
import { failure, success, type LogSink, type Result } from '../../core/crm';
import {
  CUSTOMER_GRADE_THRESHOLDS,
  SALES_PERFORMANCE_MIN_SAMPLES,
  customerGradeScopeFor,
  customerGradeFor,
  salesPerformanceScopeFor,
  type CustomerGradeItem,
  type CustomerGradeOverride,
  type CustomerGradeOverrideClear,
  type CustomerGradeOverrideReceipt,
  type CustomerGradeOverrideSet,
  type CustomerGradePage,
  type CustomerGradeQuery,
  type CustomerGradeSignals,
  type SalesPerformanceOverview,
  type SalesPerformanceQuery,
  type SalesPerformanceRepository,
  type SalesPerformanceScope,
  type SalesPerformanceStratum,
} from '../../core/sales-performance';
import { assertCenterDatabasePool } from './config';
import { migrateSalesPerformanceSchema } from './sales-performance-schema';

type Actor = {
  userId: string;
  displayName: string;
  identityAdmin: boolean;
  roles: CrmRole[];
  isLeader: boolean;
  scope: SalesPerformanceScope;
  performanceScope: SalesPerformanceScope | null;
};

type PerformanceRow = {
  groupKey: string;
  groupLabel: string;
  memberUserId: string | null;
  memberName: string | null;
  teamId: string | null;
  teamName: string | null;
  claimCount: number | string;
  customerCount: number | string;
  completedTaskCount: number | string;
  validReplyCount: number | string;
  wonOpportunityCount: number | string;
  actionMedian: number | string | null;
  actionP90: number | string | null;
  actionSamples: number | string;
  replyMedian: number | string | null;
  replyP90: number | string | null;
  replySamples: number | string;
  wonMedian: number | string | null;
  wonP90: number | string | null;
  wonSamples: number | string;
  repeatPurchaseCount: number | string;
  repeatPurchaseCustomers: number | string;
  wonCustomers: number | string;
  total: number | string;
};

type GradeRow = {
  customerId: string;
  companyName: string;
  ownerUserId: string | null;
  ownerName: string | null;
  teamId: string | null;
  teamName: string | null;
  origin: 'personal' | 'operations';
  validReplyCount: number | string;
  wonOpportunityCount: number | string;
  openOpportunityCount: number | string;
  overrideGrade: CustomerGradeItem['computedGrade'] | null;
  overrideReason: string | null;
  overrideActorId: string | null;
  overrideActorName: string | null;
  overrideVersion: number | string | null;
  overrideCreatedAt: Date | string | null;
  overrideUpdatedAt: Date | string | null;
  total: number | string;
};

type OverrideRow = {
  customerId: string;
  grade: CustomerGradeItem['effectiveGrade'];
  reason: string;
  actorId: string;
  actorName: string | null;
  version: number | string;
  createdAt: Date | string;
  updatedAt: Date | string;
};

type CustomerAccess = { origin: 'personal' | 'operations'; ownerUserId: string | null };
const OVERRIDE_OPERATION = 'customer-grade-override';
const CLEAR_OPERATION = 'customer-grade-clear';

function count(value: number | string | null | undefined): number {
  return Number(value ?? 0);
}

function metricNumber(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function visibleOrganizationCtes(scope: SalesPerformanceScope): string {
  const leaderPredicate = scope === 'leader' ? 'assignment.user_id=$1' : 'FALSE';
  return `visible_units AS (
      SELECT unit.unit_id,unit.parent_unit_id,unit.name
      FROM crm_org_units unit
      JOIN crm_org_assignments assignment ON assignment.unit_id=unit.unit_id
        AND assignment.role='leader' AND assignment.ended_at IS NULL AND ${leaderPredicate}
      WHERE unit.kind='sales_team' AND unit.dissolved_at IS NULL
      UNION
      SELECT child.unit_id,child.parent_unit_id,child.name
      FROM crm_org_units child JOIN visible_units parent ON child.parent_unit_id=parent.unit_id
      WHERE child.kind='sales_team' AND child.dissolved_at IS NULL
    ), managed_people AS (
      SELECT $1::uuid AS user_id WHERE $1::uuid IS NOT NULL
      UNION
      SELECT assignment.user_id
      FROM visible_units unit JOIN crm_org_assignments assignment ON assignment.unit_id=unit.unit_id AND assignment.ended_at IS NULL
    )`;
}

type Grouping = {
  key: string;
  label: string;
  memberUserId: string;
  memberName: string;
  teamId: string;
  teamName: string;
};

function grouping(stratum: SalesPerformanceStratum): Grouping {
  if (stratum === 'source') return {
    key: `'source:'||COALESCE(NULLIF(btrim(c.source),''),'unattributed')`,
    label: `COALESCE(NULLIF(btrim(c.source),''),'unattributed')`,
    memberUserId: 'NULL::uuid', memberName: 'NULL::text', teamId: 'NULL::uuid', teamName: 'NULL::text',
  };
  if (stratum === 'batch') return {
    key: `COALESCE(c.batch_id::text,'unattributed')`,
    label: `COALESCE(c.batch_label,c.batch_id::text,'unattributed')`,
    memberUserId: 'NULL::uuid', memberName: 'NULL::text', teamId: 'NULL::uuid', teamName: 'NULL::text',
  };
  if (stratum === 'country') return {
    key: `'country:'||COALESCE(NULLIF(btrim(c.country),''),'unattributed')`,
    label: `COALESCE(NULLIF(btrim(c.country),''),'unattributed')`,
    memberUserId: 'NULL::uuid', memberName: 'NULL::text', teamId: 'NULL::uuid', teamName: 'NULL::text',
  };
  return {
    key: 'c.owner_user_id::text', label: 'c.owner_name',
    memberUserId: 'c.owner_user_id', memberName: 'c.owner_name', teamId: 'c.team_id', teamName: 'c.team_name',
  };
}

function claimCtes(scope: SalesPerformanceScope, stratum: SalesPerformanceStratum): string {
  const group = grouping(stratum);
  const scopeFilter = scope === 'operations'
    ? "AND c.origin='operations'"
    : scope === 'leader'
      ? `AND c.owner_user_id IN (SELECT user_id FROM managed_people)`
      : scope === 'self' ? 'AND c.owner_user_id=$1' : '';
  return `WITH RECURSIVE
    ${visibleOrganizationCtes(scope)},
    claim_candidates AS (
      SELECT 'ownership:'||ownership.ownership_id AS claim_id,
        ownership.contact_id,ownership.customer_id,ownership.owner_user_id,
        ownership.started_at,ownership.ended_at,customer.origin,customer.source,
        customer.owner_user_id AS customer_owner_user_id,company.name AS company_name,
        COALESCE(NULLIF(company.country,''),NULLIF(contact.country,'')) AS country,
        imported.batch_id,imported.batch_label,
        owner.display_name AS owner_name,team.unit_id AS team_id,team.name AS team_name
      FROM crm_contact_ownership ownership
      JOIN crm_customers customer ON customer.customer_id=ownership.customer_id
      JOIN companies company ON company.id=customer.company_id
      JOIN contacts contact ON contact.id=ownership.contact_id
      JOIN public.identity_users owner ON owner.user_id=ownership.owner_user_id
      LEFT JOIN LATERAL (
        SELECT row.batch_id,batch.source_detail AS batch_label
        FROM crm_import_rows row JOIN crm_import_batches batch USING(batch_id)
        WHERE row.customer_id=ownership.customer_id
        ORDER BY batch.created_at,row.row_index LIMIT 1
      ) imported ON true
      LEFT JOIN LATERAL (
        SELECT unit.unit_id,unit.name
        FROM crm_org_assignments assignment JOIN crm_org_units unit ON unit.unit_id=assignment.unit_id
        WHERE assignment.user_id=ownership.owner_user_id AND assignment.role IN ('leader','member') AND assignment.ended_at IS NULL AND unit.dissolved_at IS NULL
        ORDER BY assignment.is_primary DESC,assignment.created_at,assignment.unit_id LIMIT 1
      ) team ON true
      UNION ALL
      SELECT 'initial:'||link.contact_id AS claim_id,
        link.contact_id,link.customer_id,customer.owner_user_id,
        contact.created_at,NULL::timestamptz,customer.origin,customer.source,
        customer.owner_user_id,company.name AS company_name,
        COALESCE(NULLIF(company.country,''),NULLIF(contact.country,'')) AS country,
        imported.batch_id,imported.batch_label,
        owner.display_name AS owner_name,team.unit_id AS team_id,team.name AS team_name
      FROM crm_customer_contacts link
      JOIN crm_customers customer ON customer.customer_id=link.customer_id
      JOIN companies company ON company.id=customer.company_id
      JOIN contacts contact ON contact.id=link.contact_id
      JOIN public.identity_users owner ON owner.user_id=customer.owner_user_id
      LEFT JOIN LATERAL (
        SELECT row.batch_id,batch.source_detail AS batch_label
        FROM crm_import_rows row JOIN crm_import_batches batch USING(batch_id)
        WHERE row.customer_id=link.customer_id
        ORDER BY batch.created_at,row.row_index LIMIT 1
      ) imported ON true
      LEFT JOIN LATERAL (
        SELECT unit.unit_id,unit.name
        FROM crm_org_assignments assignment JOIN crm_org_units unit ON unit.unit_id=assignment.unit_id
        WHERE assignment.user_id=customer.owner_user_id AND assignment.role IN ('leader','member') AND assignment.ended_at IS NULL AND unit.dissolved_at IS NULL
        ORDER BY assignment.is_primary DESC,assignment.created_at,assignment.unit_id LIMIT 1
      ) team ON true
      WHERE customer.owner_user_id IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM crm_contact_ownership history WHERE history.contact_id=link.contact_id)
    ), base_claims AS (
      SELECT c.claim_id,c.contact_id,c.customer_id,c.owner_user_id,c.started_at,
        LEAST(COALESCE(c.ended_at,'infinity'::timestamptz),$3::timestamptz) AS ended_at,
        c.origin,c.source,c.customer_owner_user_id,c.company_name,c.country,c.batch_id,c.batch_label,
        c.owner_name,c.team_id,c.team_name,
        ${group.key} AS group_key,${group.label} AS group_label,
        ${group.memberUserId} AS member_user_id,${group.memberName} AS member_name,
        ${group.teamId} AS output_team_id,${group.teamName} AS output_team_name
      FROM claim_candidates c
      WHERE c.started_at >= $2::timestamptz AND c.started_at < $3::timestamptz
        ${scopeFilter}
        AND ($4::uuid IS NULL OR EXISTS(
          SELECT 1 FROM crm_org_assignments team_assignment
          JOIN crm_org_units team_unit ON team_unit.unit_id=team_assignment.unit_id AND team_unit.dissolved_at IS NULL
          WHERE team_assignment.user_id=c.owner_user_id AND team_assignment.unit_id=$4 AND team_assignment.ended_at IS NULL
        ))
        AND ($5::uuid IS NULL OR c.owner_user_id=$5)
        AND ($6::text IS NULL OR c.source=$6)
        AND ($7::uuid IS NULL OR c.batch_id=$7)
        AND ($8::text IS NULL OR COALESCE(NULLIF(btrim(c.country),''),'unattributed')=$8)
    )`;
}

function performanceSql(scope: SalesPerformanceScope, stratum: SalesPerformanceStratum): string {
  return `${claimCtes(scope, stratum)},
    first_action_candidates AS (
      SELECT c.group_key,c.claim_id,activity.occurred_at AS action_at
      FROM base_claims c
      JOIN crm_shared_activities activity ON activity.customer_id=c.customer_id
        AND activity.contact_id=c.contact_id AND activity.actor_id=c.owner_user_id
        AND activity.occurred_at>=c.started_at AND activity.occurred_at<c.ended_at
      WHERE activity.method NOT IN ('legacy','note')
        AND (activity.contact_status IS NULL OR activity.contact_status='contacted')
      UNION ALL
      SELECT c.group_key,c.claim_id,task.completed_at
      FROM base_claims c
      JOIN crm_followup_tasks task ON task.customer_id=c.customer_id
        AND task.status='completed' AND task.completed_at>=c.started_at AND task.completed_at<c.ended_at
      WHERE COALESCE(task.source_responsible_user_id,c.customer_owner_user_id,task.completed_by)=c.owner_user_id
    ),
    first_action_events AS (
      SELECT group_key,claim_id,min(action_at) AS action_at
      FROM first_action_candidates GROUP BY group_key,claim_id
    ),
    first_action_samples AS (
      SELECT c.group_key,
        extract(epoch FROM (event.action_at-c.started_at))::double precision AS seconds
      FROM first_action_events event JOIN base_claims c USING(group_key,claim_id)
    ),
    first_action_metrics AS (
      SELECT group_key,count(*)::int AS sample_count,
        percentile_cont(0.5) WITHIN GROUP(ORDER BY seconds) AS median_seconds,
        percentile_cont(0.9) WITHIN GROUP(ORDER BY seconds) AS p90_seconds
      FROM first_action_samples GROUP BY group_key
    ),
    valid_reply_events AS (
      SELECT c.group_key,c.claim_id,event.event_id,event.occurred_at
      FROM base_claims c
      JOIN crm_contact_mail_analyses analysis ON analysis.contact_id=c.contact_id
        AND analysis.customer_id=c.customer_id AND analysis.is_current
        AND analysis.classification='replied' AND analysis.relevance='customer_business'
      JOIN crm_contact_mail_events event ON event.event_id=analysis.event_id
        AND event.kind='replied' AND event.direction='inbound'
        AND event.occurred_at>=c.started_at AND event.occurred_at<c.ended_at
    ),
    valid_reply_first AS (
      SELECT group_key,claim_id,event_id,min(occurred_at) AS replied_at
      FROM valid_reply_events GROUP BY group_key,claim_id,event_id
    ),
    valid_reply_samples AS (
      SELECT c.group_key,reply.event_id,
        extract(epoch FROM (reply.replied_at-c.started_at))::double precision AS seconds
      FROM valid_reply_first reply JOIN base_claims c USING(group_key,claim_id)
    ),
    valid_reply_metrics AS (
      SELECT group_key,count(*)::int AS sample_count,
        percentile_cont(0.5) WITHIN GROUP(ORDER BY seconds) AS median_seconds,
        percentile_cont(0.9) WITHIN GROUP(ORDER BY seconds) AS p90_seconds,
        count(DISTINCT event_id)::int AS reply_count
      FROM valid_reply_samples GROUP BY group_key
    ),
    won_events AS (
      SELECT c.group_key,history.opportunity_id,c.customer_id,
        min(c.started_at) AS claim_started_at,min(history.occurred_at) AS won_at
      FROM base_claims c
      JOIN crm_opportunity_stage_history history ON history.to_stage='closed_won'
        AND history.occurred_at>=c.started_at AND history.occurred_at<c.ended_at
      JOIN crm_opportunities opportunity ON opportunity.opportunity_id=history.opportunity_id
        AND opportunity.customer_id=c.customer_id
      GROUP BY c.group_key,history.opportunity_id,c.customer_id
    ),
    won_samples AS (
      SELECT group_key,extract(epoch FROM (won_at-claim_started_at))::double precision AS seconds
      FROM won_events
    ),
    won_metrics AS (
      SELECT group_key,count(*)::int AS sample_count,
        percentile_cont(0.5) WITHIN GROUP(ORDER BY seconds) AS median_seconds,
        percentile_cont(0.9) WITHIN GROUP(ORDER BY seconds) AS p90_seconds,
        count(*)::int AS won_count
      FROM won_samples GROUP BY group_key
    ),
    won_customer_stats AS (
      SELECT group_key,customer_id,count(DISTINCT opportunity_id)::int AS wins
      FROM won_events GROUP BY group_key,customer_id
    ),
    repeat_stats AS (
      SELECT group_key,count(*)::int AS won_customers,
        count(*) FILTER(WHERE wins>1)::int AS repeat_customers,
        COALESCE(sum(GREATEST(wins-1,0)),0)::int AS repeat_purchases
      FROM won_customer_stats GROUP BY group_key
    ),
    completed_task_stats AS (
      SELECT c.group_key,count(DISTINCT task.task_id)::int AS completed_tasks
      FROM base_claims c
      JOIN crm_followup_tasks task ON task.customer_id=c.customer_id
        AND task.status='completed' AND task.completed_at>=c.started_at AND task.completed_at<c.ended_at
      WHERE COALESCE(task.source_responsible_user_id,c.customer_owner_user_id,task.completed_by)=c.owner_user_id
      GROUP BY c.group_key
    ),
    claim_stats AS (
      SELECT group_key,max(group_label) AS group_label,
        (array_agg(DISTINCT member_user_id) FILTER(WHERE member_user_id IS NOT NULL))[1] AS member_user_id,
        max(member_name) AS member_name,
        (array_agg(DISTINCT output_team_id) FILTER(WHERE output_team_id IS NOT NULL))[1] AS team_id,
        max(output_team_name) AS team_name,
        count(DISTINCT claim_id)::int AS claim_count,
        count(DISTINCT customer_id)::int AS customer_count
      FROM base_claims GROUP BY group_key
    )
    SELECT stats.group_key AS "groupKey",stats.group_label AS "groupLabel",
      stats.member_user_id AS "memberUserId",stats.member_name AS "memberName",
      stats.team_id AS "teamId",stats.team_name AS "teamName",
      stats.claim_count AS "claimCount",stats.customer_count AS "customerCount",
      COALESCE(tasks.completed_tasks,0)::int AS "completedTaskCount",
      COALESCE(replies.reply_count,0)::int AS "validReplyCount",
      COALESCE(won.won_count,0)::int AS "wonOpportunityCount",
      actions.median_seconds AS "actionMedian",actions.p90_seconds AS "actionP90",COALESCE(actions.sample_count,0)::int AS "actionSamples",
      replies.median_seconds AS "replyMedian",replies.p90_seconds AS "replyP90",COALESCE(replies.sample_count,0)::int AS "replySamples",
      won.median_seconds AS "wonMedian",won.p90_seconds AS "wonP90",COALESCE(won.sample_count,0)::int AS "wonSamples",
      COALESCE(repeat.repeat_purchases,0)::int AS "repeatPurchaseCount",
      COALESCE(repeat.repeat_customers,0)::int AS "repeatPurchaseCustomers",
      COALESCE(repeat.won_customers,0)::int AS "wonCustomers",
      count(*) OVER()::int AS total
    FROM claim_stats stats
    LEFT JOIN first_action_metrics actions USING(group_key)
    LEFT JOIN valid_reply_metrics replies USING(group_key)
    LEFT JOIN won_metrics won USING(group_key)
    LEFT JOIN repeat_stats repeat USING(group_key)
    LEFT JOIN completed_task_stats tasks USING(group_key)
    ORDER BY stats.claim_count DESC,stats.group_label,stats.group_key
    LIMIT $9 OFFSET $10`;
}

function performanceTotalSql(scope: SalesPerformanceScope, stratum: SalesPerformanceStratum): string {
  return `${claimCtes(scope, stratum)}
    SELECT count(DISTINCT group_key)::int AS total FROM base_claims`;
}

function customerGradeSql(scope: SalesPerformanceScope): string {
  return `${claimCtes(scope, 'lead')},
    customer_base AS (
      SELECT DISTINCT ON (customer_id)
        customer_id,origin,company_name,owner_user_id,owner_name,team_id,team_name
      FROM base_claims
      ORDER BY customer_id,started_at DESC,claim_id DESC
    ),
    reply_counts AS (
      SELECT c.customer_id,count(DISTINCT event.event_id)::int AS valid_replies
      FROM base_claims c
      JOIN crm_contact_mail_analyses analysis ON analysis.contact_id=c.contact_id
        AND analysis.customer_id=c.customer_id AND analysis.is_current
        AND analysis.classification='replied' AND analysis.relevance='customer_business'
      JOIN crm_contact_mail_events event ON event.event_id=analysis.event_id
        AND event.kind='replied' AND event.direction='inbound'
        AND event.occurred_at>=c.started_at AND event.occurred_at<c.ended_at
      GROUP BY c.customer_id
    ),
    won_counts AS (
      SELECT c.customer_id,count(DISTINCT history.opportunity_id)::int AS won_opportunities
      FROM base_claims c
      JOIN crm_opportunity_stage_history history ON history.to_stage='closed_won'
        AND history.occurred_at>=c.started_at AND history.occurred_at<c.ended_at
      JOIN crm_opportunities opportunity ON opportunity.opportunity_id=history.opportunity_id
        AND opportunity.customer_id=c.customer_id
      GROUP BY c.customer_id
    ),
    open_counts AS (
      SELECT customer.customer_id,count(*)::int AS open_opportunities
      FROM customer_base customer
      JOIN crm_opportunities opportunity ON opportunity.customer_id=customer.customer_id
        AND opportunity.stage NOT IN ('closed_won','closed_lost')
      GROUP BY customer.customer_id
    ),
    grade_rows AS (
      SELECT customer.customer_id AS "customerId",customer.company_name AS "companyName",
        customer.owner_user_id AS "ownerUserId",customer.owner_name AS "ownerName",
        customer.team_id AS "teamId",customer.team_name AS "teamName",customer.origin,
        COALESCE(reply.valid_replies,0)::int AS "validReplyCount",
        COALESCE(won.won_opportunities,0)::int AS "wonOpportunityCount",
        COALESCE(open.open_opportunities,0)::int AS "openOpportunityCount",
        override.grade AS "overrideGrade",override.reason AS "overrideReason",
        override.actor_id AS "overrideActorId",actor.display_name AS "overrideActorName",
        override.version AS "overrideVersion",override.created_at AS "overrideCreatedAt",override.updated_at AS "overrideUpdatedAt",
        count(*) OVER()::int AS total
      FROM customer_base customer
      LEFT JOIN reply_counts reply USING(customer_id)
      LEFT JOIN won_counts won USING(customer_id)
      LEFT JOIN open_counts open USING(customer_id)
      LEFT JOIN crm_customer_grade_overrides override USING(customer_id)
      LEFT JOIN public.identity_users actor ON actor.user_id=override.actor_id
      WHERE ($9::uuid IS NULL OR customer.customer_id=$9)
      ORDER BY customer.company_name,customer.customer_id
      LIMIT $10 OFFSET $11
    )
    SELECT * FROM grade_rows`;
}

function customerGradeTotalSql(scope: SalesPerformanceScope): string {
  return `${claimCtes(scope, 'lead')}
    SELECT count(DISTINCT customer_id)::int AS total FROM base_claims WHERE ($9::uuid IS NULL OR customer_id=$9)`;
}

export class PostgresSalesPerformanceRepository implements SalesPerformanceRepository {
  constructor(private readonly pool: Pool, private readonly log: LogSink) {
    assertCenterDatabasePool(pool);
  }

  async migrate(): Promise<Result<void>> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await migrateSalesPerformanceSchema(client);
      await client.query(result.ok ? 'COMMIT' : 'ROLLBACK');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* The transaction is already disposed. */ }
      this.log.write('ERROR', 'sales-performance.migrate', error instanceof Error ? error.message : 'sales performance migration failed');
      return failure('DATABASE_ERROR', '销售绩效迁移失败');
    } finally {
      client.release();
    }
  }

  private async tx<T>(action: (client: PoolClient) => Promise<Result<T>>, readOnly = false): Promise<Result<T>> {
    const client = await this.pool.connect();
    try {
      await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
      const result = await action(client);
      await client.query(result.ok ? 'COMMIT' : 'ROLLBACK');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* The transaction is already disposed. */ }
      this.log.write('ERROR', 'sales-performance.pg', error instanceof Error ? error.message : 'sales performance database operation failed');
      return failure('DATABASE_ERROR', '销售绩效服务暂不可用');
    } finally {
      client.release();
    }
  }

  private async actor(client: PoolClient, tokenHash: string): Promise<Actor | null> {
    const row = (await client.query(`SELECT actor_user.user_id AS "userId",actor_user.display_name AS "displayName",
      actor_user.identity_admin AS "identityAdmin",
      EXISTS(SELECT 1 FROM crm_org_assignments assignment
        JOIN crm_org_units unit ON unit.unit_id=assignment.unit_id AND unit.dissolved_at IS NULL
        WHERE assignment.user_id=actor_user.user_id AND assignment.role='leader' AND assignment.ended_at IS NULL) AS "isLeader",
      ARRAY(SELECT grant_row.role FROM public.identity_product_grants grant_row
        WHERE grant_row.user_id=actor_user.user_id AND grant_row.product_id='crm' AND grant_row.active ORDER BY grant_row.role) AS roles
      FROM public.identity_sessions session
      JOIN public.identity_users actor_user USING(user_id)
      LEFT JOIN public.identity_product_access access_row ON access_row.user_id=actor_user.user_id
        AND access_row.product_id='crm' AND access_row.active
      WHERE session.token_hash=$1 AND session.client='api' AND session.revoked_at IS NULL
        AND session.expires_at>now() AND actor_user.active AND NOT actor_user.must_change_password
        AND session.security_revision=actor_user.security_revision
        AND (actor_user.identity_admin OR access_row.user_id IS NOT NULL)`, [tokenHash])).rows[0];
    if (!row) return null;
    const roles = (row.roles ?? []) as CrmRole[];
    const access = { identityAdmin: !!row.identityAdmin, roles, isLeader: !!row.isLeader };
    const scope = customerGradeScopeFor(access);
    return scope ? { ...row, roles, scope, performanceScope: salesPerformanceScopeFor(access) } as Actor : null;
  }

  performance(tokenHash: string, query: SalesPerformanceQuery): Promise<Result<SalesPerformanceOverview>> {
    return this.tx(async client => {
      const actor = await this.actor(client, tokenHash);
      if (!actor?.performanceScope) return failure('FORBIDDEN', '没有销售绩效访问权限');
      const values = [
        actor.userId, query.from, query.to, query.teamId ?? null, query.memberUserId ?? null,
        query.source ?? null, query.batchId ?? null, query.country ?? null, query.limit, query.offset,
      ];
      const rows = await client.query(performanceSql(actor.performanceScope, query.groupBy), values);
      const total = rows.rows.length
        ? count((rows.rows[0] as PerformanceRow).total)
        : count((await client.query(performanceTotalSql(actor.performanceScope, query.groupBy), values.slice(0, 8))).rows[0]?.total);
      return success({
        scope: actor.performanceScope,
        generatedAt: new Date().toISOString(),
        window: { from: query.from, to: query.to },
        groupBy: query.groupBy,
        items: (rows.rows as PerformanceRow[]).map(row => ({
          key: row.groupKey,
          label: row.groupLabel,
          memberUserId: row.memberUserId,
          memberName: row.memberName,
          teamId: row.teamId,
          teamName: row.teamName,
          claimCount: count(row.claimCount),
          customerCount: count(row.customerCount),
          completedTaskCount: count(row.completedTaskCount),
          validReplyCount: count(row.validReplyCount),
          wonOpportunityCount: count(row.wonOpportunityCount),
          metrics: {
            claimToFirstAction: {
              sampleCount: count(row.actionSamples), minimumSampleSize: SALES_PERFORMANCE_MIN_SAMPLES.duration,
              sufficient: count(row.actionSamples) >= SALES_PERFORMANCE_MIN_SAMPLES.duration,
              medianSeconds: metricNumber(row.actionMedian), p90Seconds: metricNumber(row.actionP90),
            },
            claimToValidReply: {
              sampleCount: count(row.replySamples), minimumSampleSize: SALES_PERFORMANCE_MIN_SAMPLES.duration,
              sufficient: count(row.replySamples) >= SALES_PERFORMANCE_MIN_SAMPLES.duration,
              medianSeconds: metricNumber(row.replyMedian), p90Seconds: metricNumber(row.replyP90),
            },
            claimToWon: {
              sampleCount: count(row.wonSamples), minimumSampleSize: SALES_PERFORMANCE_MIN_SAMPLES.duration,
              sufficient: count(row.wonSamples) >= SALES_PERFORMANCE_MIN_SAMPLES.duration,
              medianSeconds: metricNumber(row.wonMedian), p90Seconds: metricNumber(row.wonP90),
            },
            repeatPurchase: {
              repeatPurchaseCount: count(row.repeatPurchaseCount),
              repeatPurchaseCustomers: count(row.repeatPurchaseCustomers),
              wonCustomers: count(row.wonCustomers),
              rate: {
                count: count(row.repeatPurchaseCustomers), total: count(row.wonCustomers),
                rate: count(row.wonCustomers) ? Math.round((count(row.repeatPurchaseCustomers) / count(row.wonCustomers)) * 1000) / 1000 : null,
                sampleCount: count(row.wonCustomers), minimumSampleSize: SALES_PERFORMANCE_MIN_SAMPLES.repeatRate,
                sufficient: count(row.wonCustomers) >= SALES_PERFORMANCE_MIN_SAMPLES.repeatRate,
              },
            },
          },
        })),
        total,
      });
    }, true);
  }

  customerGrades(tokenHash: string, query: CustomerGradeQuery): Promise<Result<CustomerGradePage>> {
    return this.tx(async client => {
      const actor = await this.actor(client, tokenHash);
      if (!actor) return failure('FORBIDDEN', '没有客户分级访问权限');
      const values = [
        actor.userId, query.from, query.to, query.teamId ?? null, query.memberUserId ?? null,
        null, null, null, query.customerId ?? null, query.limit, query.offset,
      ];
      const rows = await client.query(customerGradeSql(actor.scope), values);
      const total = rows.rows.length
        ? count((rows.rows[0] as GradeRow).total)
        : count((await client.query(customerGradeTotalSql(actor.scope), values.slice(0, 9))).rows[0]?.total);
      return success({
        scope: actor.scope,
        generatedAt: new Date().toISOString(),
        window: { from: query.from, to: query.to },
        thresholds: CUSTOMER_GRADE_THRESHOLDS,
        items: (rows.rows as GradeRow[]).map(row => {
          const signals: CustomerGradeSignals = {
            validReplyCount: count(row.validReplyCount),
            wonOpportunityCount: count(row.wonOpportunityCount),
            repeatPurchaseCount: Math.max(0, count(row.wonOpportunityCount) - 1),
            openOpportunityCount: count(row.openOpportunityCount),
          };
          const computed = customerGradeFor(signals);
          const override: CustomerGradeOverride | null = row.overrideGrade ? {
            customerId: row.customerId,
            grade: row.overrideGrade,
            reason: row.overrideReason ?? '',
            actorId: row.overrideActorId ?? '',
            actorName: row.overrideActorName,
            version: count(row.overrideVersion),
            createdAt: iso(row.overrideCreatedAt) ?? new Date(0).toISOString(),
            updatedAt: iso(row.overrideUpdatedAt) ?? new Date(0).toISOString(),
          } : null;
          return {
            customerId: row.customerId,
            companyName: row.companyName,
            ownerUserId: row.ownerUserId,
            ownerName: row.ownerName,
            teamId: row.teamId,
            teamName: row.teamName,
            origin: row.origin,
            computedGrade: computed.grade,
            effectiveGrade: override?.grade ?? computed.grade,
            source: override ? 'manual' : 'computed',
            reasons: computed.reasons,
            signals,
            override,
          } satisfies CustomerGradeItem;
        }),
        total,
      });
    }, true);
  }

  private async accessibleCustomer(client: PoolClient, actor: Actor, customerId: string): Promise<CustomerAccess | null> {
    const access = actor.scope === 'superadmin' ? 'TRUE'
      : actor.scope === 'operations' ? "customer.origin='operations'"
        : actor.scope === 'leader'
          ? `COALESCE(ownership.owner_user_id,customer.owner_user_id) IN (SELECT user_id FROM managed_people)`
          : 'FALSE';
    const row = (await client.query(`WITH RECURSIVE
      ${visibleOrganizationCtes(actor.scope)}
      SELECT customer.origin,COALESCE(ownership.owner_user_id,customer.owner_user_id) AS "ownerUserId"
      FROM crm_customers customer
      LEFT JOIN LATERAL (
        SELECT owner_user_id FROM crm_contact_ownership
        WHERE customer_id=customer.customer_id AND ended_at IS NULL
        ORDER BY started_at DESC,ownership_id DESC LIMIT 1
      ) ownership ON true
      WHERE customer.customer_id=$2 AND (${access})
      LIMIT 1`, [actor.userId, customerId])).rows[0] as CustomerAccess | undefined;
    return row ?? null;
  }

  private async override(client: PoolClient, customerId: string): Promise<CustomerGradeOverride | null> {
    const row = (await client.query(`SELECT override.customer_id AS "customerId",override.grade,override.reason,
      override.actor_id AS "actorId",actor.display_name AS "actorName",override.version,
      override.created_at AS "createdAt",override.updated_at AS "updatedAt"
      FROM crm_customer_grade_overrides override
      LEFT JOIN public.identity_users actor ON actor.user_id=override.actor_id
      WHERE override.customer_id=$1`, [customerId])).rows[0] as OverrideRow | undefined;
    return row ? {
      customerId: row.customerId, grade: row.grade, reason: row.reason, actorId: row.actorId,
      actorName: row.actorName, version: count(row.version), createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
    } : null;
  }

  setCustomerGradeOverride(tokenHash: string, input: CustomerGradeOverrideSet): Promise<Result<CustomerGradeOverrideReceipt>> {
    return this.tx(async client => {
      const actor = await this.actor(client, tokenHash);
      if (!actor) return failure('FORBIDDEN', '没有客户等级覆盖权限');
      const access = await this.accessibleCustomer(client, actor, input.customerId);
      if (!access) return failure('NOT_FOUND', '客户不存在或不在授权范围');
      const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const replay = (await client.query(`SELECT digest,response FROM crm_customer_grade_override_idempotency
        WHERE actor_id=$1 AND operation=$2 AND idempotency_key=$3`, [actor.userId, OVERRIDE_OPERATION, input.idempotencyKey])).rows[0];
      if (replay) return replay.digest !== digest
        ? failure('CONFLICT', '幂等键已用于不同请求')
        : success(replay.response as CustomerGradeOverrideReceipt);

      await client.query('SELECT 1 FROM crm_customers WHERE customer_id=$1 FOR SHARE', [input.customerId]);
      const current = (await client.query(`SELECT grade,version FROM crm_customer_grade_overrides
        WHERE customer_id=$1 FOR UPDATE`, [input.customerId])).rows[0] as { grade: CustomerGradeItem['effectiveGrade']; version: number } | undefined;
      const currentVersion = current ? count(current.version) : 0;
      if (currentVersion !== input.expectedVersion) return failure('CONFLICT', '客户等级覆盖版本已变化');
      const version = currentVersion + 1;
      if (current) {
        await client.query(`UPDATE crm_customer_grade_overrides SET grade=$2,reason=$3,actor_id=$4,
          version=$5,updated_at=clock_timestamp() WHERE customer_id=$1`, [input.customerId, input.grade, input.reason, actor.userId, version]);
      } else {
        await client.query(`INSERT INTO crm_customer_grade_overrides(customer_id,grade,reason,actor_id,version)
          VALUES($1,$2,$3,$4,$5)`, [input.customerId, input.grade, input.reason, actor.userId, version]);
      }
      await client.query(`INSERT INTO crm_customer_grade_override_audits(
        customer_id,action,from_grade,to_grade,reason,actor_id,override_version
      ) VALUES($1,'set',$2,$3,$4,$5,$6)`, [input.customerId, current?.grade ?? null, input.grade, input.reason, actor.userId, version]);
      const receipt: CustomerGradeOverrideReceipt = { customerId: input.customerId, override: await this.override(client, input.customerId) };
      await client.query(`INSERT INTO crm_customer_grade_override_idempotency(actor_id,operation,idempotency_key,digest,response)
        VALUES($1,$2,$3,$4,$5)`, [actor.userId, OVERRIDE_OPERATION, input.idempotencyKey, digest, JSON.stringify(receipt)]);
      return success(receipt);
    });
  }

  clearCustomerGradeOverride(tokenHash: string, input: CustomerGradeOverrideClear): Promise<Result<CustomerGradeOverrideReceipt>> {
    return this.tx(async client => {
      const actor = await this.actor(client, tokenHash);
      if (!actor) return failure('FORBIDDEN', '没有客户等级覆盖权限');
      const access = await this.accessibleCustomer(client, actor, input.customerId);
      if (!access) return failure('NOT_FOUND', '客户不存在或不在授权范围');
      const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const replay = (await client.query(`SELECT digest,response FROM crm_customer_grade_override_idempotency
        WHERE actor_id=$1 AND operation=$2 AND idempotency_key=$3`, [actor.userId, CLEAR_OPERATION, input.idempotencyKey])).rows[0];
      if (replay) return replay.digest !== digest
        ? failure('CONFLICT', '幂等键已用于不同请求')
        : success(replay.response as CustomerGradeOverrideReceipt);

      await client.query('SELECT 1 FROM crm_customers WHERE customer_id=$1 FOR SHARE', [input.customerId]);
      const current = (await client.query(`SELECT grade,version FROM crm_customer_grade_overrides
        WHERE customer_id=$1 FOR UPDATE`, [input.customerId])).rows[0] as { grade: CustomerGradeItem['effectiveGrade']; version: number } | undefined;
      if (!current) return failure('CONFLICT', '客户没有可清除的人工等级');
      const currentVersion = count(current.version);
      if (currentVersion !== input.expectedVersion) return failure('CONFLICT', '客户等级覆盖版本已变化');
      const version = currentVersion + 1;
      await client.query(`INSERT INTO crm_customer_grade_override_audits(
        customer_id,action,from_grade,to_grade,reason,actor_id,override_version
      ) VALUES($1,'clear',$2,NULL,$3,$4,$5)`, [input.customerId, current.grade, input.reason, actor.userId, version]);
      await client.query('DELETE FROM crm_customer_grade_overrides WHERE customer_id=$1 AND version=$2', [input.customerId, current.version]);
      const receipt: CustomerGradeOverrideReceipt = { customerId: input.customerId, override: null };
      await client.query(`INSERT INTO crm_customer_grade_override_idempotency(actor_id,operation,idempotency_key,digest,response)
        VALUES($1,$2,$3,$4,$5)`, [actor.userId, CLEAR_OPERATION, input.idempotencyKey, digest, JSON.stringify(receipt)]);
      return success(receipt);
    });
  }
}
