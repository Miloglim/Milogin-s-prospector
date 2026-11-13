import type { Pool, PoolClient } from 'pg';
import type { CrmRole } from '../../core/auth';
import { failure, success, type LogSink, type Result } from '../../core/crm';
import type {
  TeamMonitoringAttentionSummary,
  TeamMonitoringContactSummary,
  TeamMonitoringCounts,
  TeamMonitoringMailDetail,
  TeamMonitoringMailSummary,
  TeamMonitoringMemberDetail,
  TeamMonitoringMemberSummary,
  TeamMonitoringOverview,
  TeamMonitoringPoolSummary,
  TeamMonitoringQuery,
  TeamMonitoringRates,
  TeamMonitoringRepository,
  TeamMonitoringScope,
  TeamMonitoringStageCounts,
  TeamMonitoringUnitSummary,
} from '../../core/team-monitoring';
import { teamMonitoringScopeFor } from '../../core/team-monitoring';
import type { MailAnalysisSource, MailBusinessSignal, MailIntentCode, MailPriority, MailRelevance } from '../../core/mail-analysis';
import type { MailClassification } from '../../core/contact-mail';
import { assertCenterDatabasePool } from './config';
import { migrateTeamMonitoringSchema } from './team-monitoring-schema';

interface MonitoringActor {
  userId: string;
  displayName: string;
  identityAdmin: boolean;
  roles: CrmRole[];
  scope: TeamMonitoringScope;
}

type CountRow = {
  contacts: number | string;
  uncontacted: number | string;
  contacted: number | string;
  replied: number | string;
  bounced: number | string;
  autoreply: number | string;
  openActions: number | string;
  overdueActions: number | string;
  importantReplies: number | string;
  openAttention: number | string;
  pendingAssignments: number | string;
  pendingTransfers: number | string;
};

type MemberRow = CountRow & {
  userId: string;
  displayName: string;
  email: string | null;
  teamId: string;
  teamName: string;
  organizationKind: TeamMonitoringMemberSummary['organizationKind'];
  stages: Record<string, number | string> | null;
  lastActivityAt: Date | string | null;
  latestImportantReplyAt: Date | string | null;
};

type UnitRow = CountRow & {
  unitId: string;
  name: string;
  kind: TeamMonitoringUnitSummary['kind'];
  parentUnitId: string | null;
  memberCount: number | string;
};

type MailRow = {
  eventId: string;
  contactId: number | string;
  customerId: string;
  subject: string;
  kind: string;
  direction: 'inbound' | 'outbound';
  occurredAt: Date | string;
  analysisId: string | null;
  classification: MailClassification | null;
  relevance: MailRelevance | null;
  summary: string | null;
  signals: MailBusinessSignal[] | string | null;
  requiresAction: boolean | null;
  nextAction: string | null;
  priority: MailPriority | null;
  confidence: number | string | null;
  source: MailAnalysisSource | null;
  analyzerVersion: string | null;
};

const COUNT_SELECT = `
  COALESCE(cs.contacts,0)::int AS contacts,
  COALESCE(cs.uncontacted,0)::int AS uncontacted,
  COALESCE(cs.contacted,0)::int AS contacted,
  COALESCE(cs.replied,0)::int AS replied,
  COALESCE(cs.bounced,0)::int AS bounced,
  COALESCE(cs.autoreply,0)::int AS autoreply,
  COALESCE(ts.open_actions,0)::int AS "openActions",
  COALESCE(ts.overdue_actions,0)::int AS "overdueActions",
  COALESCE(ms.important_replies,0)::int AS "importantReplies",
  COALESCE(ats.open_attention,0)::int AS "openAttention",
  COALESCE(ass.pending_assignments,0)::int AS "pendingAssignments",
  COALESCE(ass.pending_transfers,0)::int AS "pendingTransfers"
`;

function visibleUnitsCte(scope: TeamMonitoringScope): string {
  if (scope !== 'leader') {
    return `visible_units AS (
      SELECT unit_id,parent_unit_id,name,kind FROM crm_org_units
      WHERE kind<>'company' AND dissolved_at IS NULL AND $1::uuid IS NOT NULL
    )`;
  }
  return `visible_units AS (
      SELECT u.unit_id,u.parent_unit_id,u.name,u.kind
      FROM crm_org_units u
      JOIN crm_org_assignments a ON a.unit_id=u.unit_id AND a.role='leader' AND a.ended_at IS NULL
      WHERE a.user_id=$1 AND u.kind<>'company' AND u.dissolved_at IS NULL
      UNION
      SELECT child.unit_id,child.parent_unit_id,child.name,child.kind
      FROM crm_org_units child JOIN visible_units parent ON child.parent_unit_id=parent.unit_id
      WHERE child.dissolved_at IS NULL
    )`;
}

function statsCtes(scope: TeamMonitoringScope): string {
  const originFilter = scope === 'operations' ? "AND c.origin='operations'" : '';
  const leaderContactFilter = scope === 'leader'
    ? `AND COALESCE(own.owner_user_id,c.owner_user_id) IN (SELECT "userId" FROM visible_members)`
    : '';
  const leaderTaskFilter = scope === 'leader'
    ? `AND COALESCE(task.source_responsible_user_id,c.owner_user_id,c.created_by) IN (SELECT "userId" FROM visible_members)`
    : '';
  const assignmentScopeFilter = scope === 'operations'
    ? "AND customer.origin='operations'"
    : scope === 'leader'
      ? `AND EXISTS(SELECT 1 FROM visible_members member_scope WHERE member_scope."userId"=request.target_user_id)`
      : '';
  return `WITH RECURSIVE
    ${visibleUnitsCte(scope)},
    visible_members AS (
      SELECT a.user_id AS "userId",u.display_name AS "displayName",e.email,
        unit.unit_id AS "teamId",unit.name AS "teamName",unit.kind AS "organizationKind"
      FROM visible_units unit
      JOIN crm_org_assignments a ON a.unit_id=unit.unit_id AND a.role='member' AND a.ended_at IS NULL
      JOIN public.identity_users u ON u.user_id=a.user_id
      LEFT JOIN LATERAL (
        SELECT email FROM public.identity_login_emails mail
        WHERE mail.user_id=a.user_id ORDER BY mail.verified_at DESC NULLS LAST,mail.email LIMIT 1
      ) e ON true
    ),
    contact_facts AS (
      SELECT cc.contact_id AS "contactId",cc.customer_id AS "customerId",
        COALESCE(own.owner_user_id,c.owner_user_id) AS "ownerUserId",
        ct.crm_touch_status AS "touchStatus",c.relationship_stage AS stage,c.origin,
        co.name AS "companyName",
        COALESCE(NULLIF(concat_ws(' ',ct.first_name,ct.last_name),''),NULLIF(ct.email,''),'') AS "contactName",
        ct.created_at AS "createdAt",ct.updated_at AS "updatedAt"
      FROM crm_customer_contacts cc
      JOIN contacts ct ON ct.id=cc.contact_id AND ct.crm_deleted_at IS NULL
      JOIN crm_customers c ON c.customer_id=cc.customer_id
      JOIN companies co ON co.id=c.company_id AND co.crm_deleted_at IS NULL
      LEFT JOIN crm_contact_ownership own ON own.contact_id=cc.contact_id
        AND own.customer_id=cc.customer_id AND own.ended_at IS NULL
      WHERE 1=1 ${originFilter} ${leaderContactFilter}
    ),
    contact_stats AS (
      SELECT "ownerUserId" AS user_id,
        count(*) AS contacts,
        count(*) FILTER(WHERE "touchStatus"='uncontacted') AS uncontacted,
        count(*) FILTER(WHERE "touchStatus"='contacted') AS contacted,
        count(*) FILTER(WHERE "touchStatus"='replied') AS replied,
        count(*) FILTER(WHERE "touchStatus"='bounced') AS bounced,
        count(*) FILTER(WHERE "touchStatus"='autoreply') AS autoreply
      FROM contact_facts WHERE "ownerUserId" IS NOT NULL GROUP BY "ownerUserId"
    ),
    stage_stats AS (
      SELECT "ownerUserId" AS user_id,jsonb_object_agg(stage,total) AS stages
      FROM (
        SELECT "ownerUserId",stage,count(DISTINCT "customerId")::int AS total
        FROM contact_facts WHERE "ownerUserId" IS NOT NULL GROUP BY "ownerUserId",stage
      ) grouped GROUP BY "ownerUserId"
    ),
    mail_stats AS (
      SELECT analysis.actor_id AS user_id,
        count(DISTINCT event.event_id) FILTER(WHERE analysis.classification='replied'
          AND analysis.relevance='customer_business' AND analysis.priority IN ('important','urgent')) AS important_replies,
        max(event.occurred_at) FILTER(WHERE analysis.classification='replied'
          AND analysis.relevance='customer_business' AND analysis.priority IN ('important','urgent')) AS latest_important_reply
      FROM crm_contact_mail_analyses analysis
      JOIN contact_facts contact ON contact."contactId"=analysis.contact_id
        AND contact."customerId"=analysis.customer_id AND contact."ownerUserId"=analysis.actor_id
      JOIN crm_contact_mail_events event ON event.event_id=analysis.event_id
      WHERE analysis.is_current GROUP BY analysis.actor_id
    ),
    task_stats AS (
      SELECT COALESCE(task.source_responsible_user_id,c.owner_user_id,c.created_by) AS user_id,
        count(*) FILTER(WHERE task.status='open') AS open_actions,
        count(*) FILTER(WHERE task.status='open' AND task.due_at<clock_timestamp()) AS overdue_actions
      FROM crm_followup_tasks task JOIN crm_customers c USING(customer_id)
      WHERE 1=1 ${scope === 'operations' ? "AND c.origin='operations'" : ''} ${leaderTaskFilter}
      GROUP BY COALESCE(task.source_responsible_user_id,c.owner_user_id,c.created_by)
    ),
    attention_stats AS (
      SELECT item.target_member_user_id AS user_id,
        count(*) FILTER(WHERE item.status IN ('open','acknowledged')) AS open_attention
      FROM crm_team_attention_items item
      JOIN contact_facts contact ON contact."contactId"=item.contact_id AND contact."customerId"=item.customer_id
      GROUP BY item.target_member_user_id
    ),
    assignment_stats AS (
      SELECT request.target_user_id AS user_id,
        count(*) FILTER(WHERE request.status='pending') AS pending_assignments,
        count(*) FILTER(WHERE request.status='pending_transfer') AS pending_transfers
      FROM crm_contact_assignment_requests request
      JOIN crm_customers customer ON customer.customer_id=request.customer_id
      WHERE 1=1 ${assignmentScopeFilter}
      GROUP BY request.target_user_id
    ),
    activity_stats AS (
      SELECT contact."ownerUserId" AS user_id,max(activity.occurred_at) AS last_activity
      FROM crm_shared_activities activity
      JOIN contact_facts contact ON contact."customerId"=activity.customer_id
        AND (activity.contact_id IS NULL OR activity.contact_id=contact."contactId")
      WHERE activity.method NOT IN ('legacy','note') AND contact."ownerUserId" IS NOT NULL
      GROUP BY contact."ownerUserId"
    ),
    member_stats AS (
      SELECT member.*,
        ${COUNT_SELECT},
        COALESCE(stage.stages,'{}'::jsonb) AS stages,
        activity.last_activity AS "lastActivityAt",
        ms.latest_important_reply AS "latestImportantReplyAt"
      FROM visible_members member
      LEFT JOIN contact_stats cs ON cs.user_id=member."userId"
      LEFT JOIN stage_stats stage ON stage.user_id=member."userId"
      LEFT JOIN task_stats ts ON ts.user_id=member."userId"
      LEFT JOIN mail_stats ms ON ms.user_id=member."userId"
      LEFT JOIN attention_stats ats ON ats.user_id=member."userId"
      LEFT JOIN assignment_stats ass ON ass.user_id=member."userId"
      LEFT JOIN activity_stats activity ON activity.user_id=member."userId"
    )`;
}

const MAIL_SUMMARY_SELECT = `
  event.event_id AS "eventId",event.contact_id AS "contactId",event.customer_id AS "customerId",
  event.subject,event.kind,event.direction,event.occurred_at AS "occurredAt",
  analysis.analysis_id AS "analysisId",analysis.classification,analysis.relevance,analysis.summary,
  analysis.signals,analysis.requires_action AS "requiresAction",analysis.next_action AS "nextAction",
  analysis.priority,analysis.confidence,analysis.source,analysis.analyzer_version AS "analyzerVersion"`;

function number(value: number | string | null | undefined): number {
  return Number(value ?? 0);
}

function iso(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : new Date(value).toISOString();
}

function jsonSignals(value: MailBusinessSignal[] | string | null): MailBusinessSignal[] {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as MailBusinessSignal[] : [];
  } catch {
    return []; // The database constrains signals to JSON arrays; malformed legacy text is ignored.
  }
}

function counts(row: CountRow): TeamMonitoringCounts {
  return {
    contacts: number(row.contacts), uncontacted: number(row.uncontacted), contacted: number(row.contacted),
    replied: number(row.replied), bounced: number(row.bounced), autoreply: number(row.autoreply),
    openActions: number(row.openActions), overdueActions: number(row.overdueActions),
    importantReplies: number(row.importantReplies), openAttention: number(row.openAttention),
    pendingAssignments: number(row.pendingAssignments), pendingTransfers: number(row.pendingTransfers),
  };
}

function rates(value: TeamMonitoringCounts): TeamMonitoringRates {
  const touched = Math.max(0, value.contacts - value.uncontacted);
  const ratio = (part: number, whole: number) => whole > 0 ? Math.round((part / whole) * 10000) / 10000 : 0;
  return {
    contactRate: ratio(touched, value.contacts),
    replyRate: ratio(value.replied, touched),
    bounceRate: ratio(value.bounced, touched),
    actionRate: ratio(value.openActions, value.contacts),
  };
}

function stages(value: Record<string, number | string> | null): TeamMonitoringStageCounts {
  return {
    cold: number(value?.cold), reaching: number(value?.reaching), quoting: number(value?.quoting),
    trial: number(value?.trial), cooperating: number(value?.cooperating), lost: number(value?.lost), other: number(value?.other),
  };
}

function member(row: MemberRow): TeamMonitoringMemberSummary {
  const value = counts(row);
  return {
    userId: row.userId, displayName: row.displayName, email: row.email,
    teamId: row.teamId, teamName: row.teamName, organizationKind: row.organizationKind,
    counts: value, rates: rates(value), stages: stages(row.stages),
    lastActivityAt: iso(row.lastActivityAt), latestImportantReplyAt: iso(row.latestImportantReplyAt),
  };
}

function mail(row: MailRow): TeamMonitoringMailSummary {
  const signals = jsonSignals(row.signals);
  return {
    eventId: row.eventId, contactId: number(row.contactId), customerId: row.customerId,
    subject: row.subject, kind: row.kind, direction: row.direction, occurredAt: new Date(row.occurredAt).toISOString(),
    analysisId: row.analysisId, classification: row.classification, relevance: row.relevance, summary: row.summary,
    signals, intent: (signals[0]?.code as MailIntentCode | undefined) ?? null,
    requiresAction: row.requiresAction ?? false, nextAction: row.nextAction, priority: row.priority,
    confidence: row.confidence === null ? null : number(row.confidence), source: row.source, analyzerVersion: row.analyzerVersion,
  };
}

export class PostgresTeamMonitoringRepository implements TeamMonitoringRepository {
  constructor(private readonly pool: Pool, private readonly log: LogSink) {
    assertCenterDatabasePool(pool);
  }

  async migrate(): Promise<Result<void>> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await migrateTeamMonitoringSchema(client);
      await client.query(result.ok ? 'COMMIT' : 'ROLLBACK');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* The transaction is already disposed. */ }
      this.log.write('ERROR', 'team-monitoring.migrate', error instanceof Error ? error.message : 'monitoring migration failed');
      return failure('DATABASE_ERROR', '团队监控迁移失败');
    } finally {
      client.release();
    }
  }

  private async actor(client: PoolClient, tokenHash: string): Promise<MonitoringActor | null> {
    const row = (await client.query(`SELECT actor_user.user_id AS "userId",actor_user.display_name AS "displayName",
      actor_user.identity_admin AS "identityAdmin",
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
    const scope = teamMonitoringScopeFor({ identityAdmin: !!row.identityAdmin, roles });
    if (!scope) return null;
    if (scope === 'leader') {
      const leader = await client.query("SELECT 1 FROM crm_org_assignments assignment JOIN crm_org_units unit ON unit.unit_id=assignment.unit_id AND unit.dissolved_at IS NULL WHERE assignment.user_id=$1 AND assignment.role='leader' AND assignment.ended_at IS NULL LIMIT 1", [row.userId]);
      if (!leader.rowCount) return null;
    }
    return { userId: String(row.userId), displayName: String(row.displayName), identityAdmin: !!row.identityAdmin, roles, scope };
  }

  private async read<T>(tokenHash: string, work: (client: PoolClient, actor: MonitoringActor) => Promise<Result<T>>): Promise<Result<T>> {
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      const actor = await this.actor(client, tokenHash);
      if (!actor) return failure('FORBIDDEN', '当前账号没有团队监控权限');
      return await work(client, actor);
    } catch (error) {
      const detail = error && typeof error === 'object' && 'position' in error ? ` position=${String(error.position)}` : '';
      this.log.write('ERROR', 'team-monitoring.read', `${error instanceof Error ? error.message : 'team monitoring read failed'}${detail}`);
      return failure('DATABASE_ERROR', '团队监控暂不可用');
    } finally {
      client?.release();
    }
  }

  private async audited<T>(tokenHash: string, work: (client: PoolClient, actor: MonitoringActor) => Promise<Result<T>>): Promise<Result<T>> {
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      const actor = await this.actor(client, tokenHash);
      if (!actor) { await client.query('ROLLBACK'); return failure('FORBIDDEN', '当前账号没有团队监控权限'); }
      const result = await work(client, actor);
      await client.query(result.ok ? 'COMMIT' : 'ROLLBACK');
      return result;
    } catch (error) {
      if (client) try { await client.query('ROLLBACK'); } catch { /* The transaction is already disposed. */ }
      this.log.write('ERROR', 'team-monitoring.audit', error instanceof Error ? error.message : 'team monitoring audit failed');
      return failure('DATABASE_ERROR', '团队监控读取失败');
    } finally {
      client?.release();
    }
  }

  private async accessibleContact(client: PoolClient, actor: MonitoringActor, contactId: number, customerId: string): Promise<boolean> {
    const access = actor.scope === 'superadmin' ? 'TRUE'
      : actor.scope === 'operations' ? "c.origin='operations'"
        : `EXISTS(SELECT 1 FROM crm_org_assignments member_scope
            JOIN crm_org_units unit_scope ON unit_scope.unit_id=member_scope.unit_id AND unit_scope.dissolved_at IS NULL
            JOIN crm_org_assignments leader_scope ON leader_scope.unit_id=member_scope.unit_id
              AND leader_scope.role='leader' AND leader_scope.user_id=$3 AND leader_scope.ended_at IS NULL
            WHERE member_scope.user_id=COALESCE(own.owner_user_id,c.owner_user_id) AND member_scope.role='member' AND member_scope.ended_at IS NULL)`;
    const params = actor.scope === 'leader' ? [contactId, customerId, actor.userId] : [contactId, customerId];
    const row = await client.query(`SELECT 1 FROM crm_customer_contacts cc
      JOIN contacts ct ON ct.id=cc.contact_id AND ct.crm_deleted_at IS NULL
      JOIN crm_customers c ON c.customer_id=cc.customer_id
      JOIN companies company ON company.id=c.company_id AND company.crm_deleted_at IS NULL
      LEFT JOIN crm_contact_ownership own ON own.contact_id=cc.contact_id
        AND own.customer_id=cc.customer_id AND own.ended_at IS NULL
      WHERE cc.contact_id=$1 AND cc.customer_id=$2 AND ${access} LIMIT 1`, params);
    return row.rowCount === 1;
  }

  private async audit(client: PoolClient, actor: MonitoringActor, targetKind: 'contact' | 'mail', targetId: string, contactId: number, customerId: string, mailEventId: string | null): Promise<string> {
    return String((await client.query(`INSERT INTO crm_team_monitoring_audits(
      actor_id,scope,target_kind,target_id,contact_id,customer_id,mail_event_id
    ) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING audit_id`, [actor.userId, actor.scope, targetKind, targetId, contactId, customerId, mailEventId])).rows[0].audit_id);
  }

  private async visibleSelection(client: PoolClient, scope: TeamMonitoringScope, actorId: string, query: TeamMonitoringQuery): Promise<Result<void>> {
    const ctes = statsCtes(scope);
    if (query.teamId) {
      const team = await client.query(`${ctes} SELECT 1 FROM visible_units WHERE unit_id=$2 LIMIT 1`, [actorId, query.teamId]);
      if (!team.rowCount) return failure('NOT_FOUND', '团队不存在或不在监控范围');
    }
    if (query.memberUserId) {
      const member = await client.query(`${ctes} SELECT 1 FROM visible_members WHERE "userId"=$2
        AND ($3::uuid IS NULL OR "teamId"=$3) LIMIT 1`, [actorId, query.memberUserId, query.teamId ?? null]);
      if (!member.rowCount) return failure('NOT_FOUND', '成员不存在或不在监控范围');
    }
    return success(undefined);
  }

  overview(tokenHash: string, query: TeamMonitoringQuery): Promise<Result<TeamMonitoringOverview>> {
    return this.read(tokenHash, async (client, actor) => {
      const visible = await this.visibleSelection(client, actor.scope, actor.userId, query);
      if (!visible.ok) return visible;
      const ctes = statsCtes(actor.scope);
      const filter = `WHERE ($2::uuid IS NULL OR "teamId"=$2) AND ($3::uuid IS NULL OR "userId"=$3)`;
      const memberRows = await client.query(`${ctes}
        SELECT * FROM member_stats ${filter}
        ORDER BY COALESCE("lastActivityAt","latestImportantReplyAt") DESC NULLS LAST,"displayName","userId" LIMIT $4 OFFSET $5`,
      [actor.userId, query.teamId ?? null, query.memberUserId ?? null, query.limit, query.offset]);
      const totalMembers = await client.query(`${ctes} SELECT count(*)::int AS total FROM member_stats ${filter}`,
        [actor.userId, query.teamId ?? null, query.memberUserId ?? null]);
      const totals = await client.query(`${ctes}
        SELECT COALESCE(sum("contacts"),0)::int AS contacts,
          COALESCE(sum("uncontacted"),0)::int AS uncontacted,
          COALESCE(sum("contacted"),0)::int AS contacted,
          COALESCE(sum("replied"),0)::int AS replied,
          COALESCE(sum("bounced"),0)::int AS bounced,
          COALESCE(sum("autoreply"),0)::int AS autoreply,
          COALESCE(sum("openActions"),0)::int AS "openActions",
          COALESCE(sum("overdueActions"),0)::int AS "overdueActions",
          COALESCE(sum("importantReplies"),0)::int AS "importantReplies",
          COALESCE(sum("openAttention"),0)::int AS "openAttention",
          COALESCE(sum("pendingAssignments"),0)::int AS "pendingAssignments",
          COALESCE(sum("pendingTransfers"),0)::int AS "pendingTransfers"
        FROM member_stats ${filter}`,
      [actor.userId, query.teamId ?? null, query.memberUserId ?? null]);
      const unitRows = await client.query(`${ctes}
        SELECT unit.unit_id AS "unitId",unit.name,unit.kind,unit.parent_unit_id AS "parentUnitId",
          count(DISTINCT member."userId")::int AS "memberCount",
          COALESCE(sum(member."contacts"),0)::int AS contacts,
          COALESCE(sum(member."uncontacted"),0)::int AS uncontacted,
          COALESCE(sum(member."contacted"),0)::int AS contacted,
          COALESCE(sum(member."replied"),0)::int AS replied,
          COALESCE(sum(member."bounced"),0)::int AS bounced,
          COALESCE(sum(member."autoreply"),0)::int AS autoreply,
          COALESCE(sum(member."openActions"),0)::int AS "openActions",
          COALESCE(sum(member."overdueActions"),0)::int AS "overdueActions",
          COALESCE(sum(member."importantReplies"),0)::int AS "importantReplies",
          COALESCE(sum(member."openAttention"),0)::int AS "openAttention",
          COALESCE(sum(member."pendingAssignments"),0)::int AS "pendingAssignments",
          COALESCE(sum(member."pendingTransfers"),0)::int AS "pendingTransfers"
        FROM visible_units unit
        LEFT JOIN member_stats member ON member."teamId"=unit.unit_id
        WHERE ($2::uuid IS NULL OR unit.unit_id=$2) AND ($3::uuid IS NULL OR member."userId"=$3)
        GROUP BY unit.unit_id,unit.name,unit.kind,unit.parent_unit_id
        ORDER BY max(COALESCE(member."lastActivityAt",member."latestImportantReplyAt")) DESC NULLS LAST,unit.name,unit.unit_id LIMIT $4 OFFSET $5`,
      [actor.userId, query.teamId ?? null, query.memberUserId ?? null, query.unitLimit, query.unitOffset]);
      const totalUnits = await client.query(`${ctes}
        SELECT count(DISTINCT unit.unit_id)::int AS total FROM visible_units unit
        LEFT JOIN member_stats member ON member."teamId"=unit.unit_id
        WHERE ($2::uuid IS NULL OR unit.unit_id=$2) AND ($3::uuid IS NULL OR member."userId"=$3)`,
      [actor.userId, query.teamId ?? null, query.memberUserId ?? null]);
      const important = await client.query(`${ctes}
        SELECT ${MAIL_SUMMARY_SELECT}
        FROM contact_facts contact
        JOIN member_stats owner ON owner."userId"=contact."ownerUserId"
        JOIN crm_contact_mail_events event ON event.contact_id=contact."contactId" AND event.customer_id=contact."customerId"
        JOIN LATERAL (
          SELECT analysis.* FROM crm_contact_mail_analyses analysis
          WHERE analysis.event_id=event.event_id AND analysis.is_current
            AND analysis.actor_id=contact."ownerUserId" AND analysis.classification='replied'
            AND analysis.relevance='customer_business' AND analysis.priority IN ('important','urgent')
          ORDER BY analysis.created_at DESC,analysis.analysis_id DESC LIMIT 1
        ) analysis ON true
        WHERE ($2::uuid IS NULL OR owner."teamId"=$2) AND ($3::uuid IS NULL OR owner."userId"=$3)
        ORDER BY event.occurred_at DESC,event.event_id LIMIT 10`,
      [actor.userId, query.teamId ?? null, query.memberUserId ?? null]);
      const pool = actor.scope === 'leader' ? null : await client.query(`${ctes}
        SELECT
          count(*) FILTER(WHERE contact.origin='operations' AND contact."ownerUserId" IS NULL)::int AS "unassignedOperationsContacts",
          count(*) FILTER(WHERE contact.origin='operations' AND contact."ownerUserId" IS NOT NULL)::int AS "assignedOperationsContacts",
          count(*) FILTER(WHERE request.status='pending' AND c.origin='operations')::int AS "pendingAssignmentRequests",
          count(*) FILTER(WHERE request.status='pending_transfer' AND c.origin='operations')::int AS "pendingTransferRequests"
        FROM contact_facts contact
        LEFT JOIN crm_customers c ON c.customer_id=contact."customerId"
        LEFT JOIN crm_contact_assignment_requests request ON request.contact_id=contact."contactId"
          AND request.customer_id=contact."customerId" AND request.status IN ('pending','pending_transfer')`,
      [actor.userId]);
      const total = counts(totals.rows[0] as CountRow);
      const unitItems = (unitRows.rows as UnitRow[]).map(row => {
        const value = counts(row);
        return { unitId: row.unitId, name: row.name, kind: row.kind, parentUnitId: row.parentUnitId,
          memberCount: number(row.memberCount), counts: value, rates: rates(value) };
      });
      return success({
        scope: actor.scope,
        generatedAt: new Date().toISOString(),
        units: { items: unitItems, total: number(totalUnits.rows[0].total) },
        members: { items: (memberRows.rows as MemberRow[]).map(member), total: number(totalMembers.rows[0].total) },
        counts: total,
        rates: rates(total),
        pool: pool ? {
          unassignedOperationsContacts: number(pool.rows[0].unassignedOperationsContacts),
          assignedOperationsContacts: number(pool.rows[0].assignedOperationsContacts),
          pendingAssignmentRequests: number(pool.rows[0].pendingAssignmentRequests),
          pendingTransferRequests: number(pool.rows[0].pendingTransferRequests),
        } satisfies TeamMonitoringPoolSummary : null,
        importantReplies: (important.rows as MailRow[]).map(mail),
      });
    });
  }

  member(tokenHash: string, userId: string, limit: number, offset: number): Promise<Result<TeamMonitoringMemberDetail>> {
    return this.read(tokenHash, async (client, actor) => {
      const visible = await this.visibleSelection(client, actor.scope, actor.userId, {
        memberUserId: userId, limit, offset, unitLimit: 1, unitOffset: 0,
      });
      if (!visible.ok) return visible;
      const ctes = statsCtes(actor.scope);
      const summary = (await client.query(`${ctes} SELECT * FROM member_stats WHERE "userId"=$2 LIMIT 1`, [actor.userId, userId])).rows[0] as MemberRow | undefined;
      if (!summary) return failure('NOT_FOUND', '成员不存在或不在监控范围');
      const recentActions = await client.query(`${ctes}
        SELECT task.task_id::text AS "actionId",'task'::text AS kind,task.title,
          customer.customer_id AS "customerId",company.name AS "customerName",
          task.source_contact_id AS "contactId",
          COALESCE(NULLIF(concat_ws(' ',contact.first_name,contact.last_name),''),contact.email) AS "contactName",
          task.due_at AS "dueAt",task.created_at AS "occurredAt",'normal'::text AS priority
        FROM crm_followup_tasks task
        JOIN crm_customers customer USING(customer_id)
        JOIN companies company ON company.id=customer.company_id
        LEFT JOIN contacts contact ON contact.id=task.source_contact_id
        WHERE task.status='open' AND COALESCE(task.source_responsible_user_id,customer.owner_user_id,customer.created_by)=$2
          ${actor.scope === 'operations' ? "AND customer.origin='operations'" : ''}
        UNION ALL
        SELECT item.item_id::text,'attention',item.reason,customer.customer_id,company.name,item.contact_id,
          COALESCE(NULLIF(concat_ws(' ',contact.first_name,contact.last_name),''),contact.email),
          NULL,item.created_at,item.priority
        FROM crm_team_attention_items item
        JOIN crm_customers customer USING(customer_id)
        JOIN companies company ON company.id=customer.company_id
        JOIN contacts contact ON contact.id=item.contact_id
        WHERE item.target_member_user_id=$2 AND item.status IN ('open','acknowledged')
        ORDER BY "occurredAt" DESC LIMIT 20`, [actor.userId, userId]);
      const attention = await client.query(`${ctes}
        SELECT item.item_id AS "itemId",item.target_member_user_id AS "memberUserId",member."displayName" AS "memberName",
          item.customer_id AS "customerId",company.name AS "customerName",item.contact_id AS "contactId",
          COALESCE(NULLIF(concat_ws(' ',contact.first_name,contact.last_name),''),contact.email) AS "contactName",
          item.reason,item.priority,item.status,item.note,item.updated_at AS "updatedAt"
        FROM crm_team_attention_items item
        JOIN member_stats member ON member."userId"=item.target_member_user_id
        JOIN contact_facts scoped_contact ON scoped_contact."contactId"=item.contact_id
          AND scoped_contact."customerId"=item.customer_id
        JOIN crm_customers customer ON customer.customer_id=item.customer_id
        JOIN companies company ON company.id=customer.company_id
        JOIN contacts contact ON contact.id=item.contact_id
        WHERE item.target_member_user_id=$2 AND item.status IN ('open','acknowledged')
        ORDER BY CASE item.priority WHEN 'urgent' THEN 0 WHEN 'important' THEN 1 ELSE 2 END,item.updated_at DESC,item.item_id
        LIMIT 20`, [actor.userId, userId]);
      const recentMail = await client.query(`${ctes}
        SELECT ${MAIL_SUMMARY_SELECT}
        FROM contact_facts contact
        JOIN member_stats owner ON owner."userId"=contact."ownerUserId"
        JOIN crm_contact_mail_events event ON event.contact_id=contact."contactId" AND event.customer_id=contact."customerId"
        LEFT JOIN LATERAL (
          SELECT analysis.* FROM crm_contact_mail_analyses analysis
          WHERE analysis.event_id=event.event_id AND analysis.is_current
          ORDER BY analysis.created_at DESC,analysis.analysis_id DESC LIMIT 1
        ) analysis ON true
        WHERE owner."userId"=$2
        ORDER BY event.occurred_at DESC,event.event_id DESC LIMIT $3 OFFSET $4`, [actor.userId, userId, limit, offset]);
      return success({
        scope: actor.scope,
        generatedAt: new Date().toISOString(),
        member: member(summary),
        recentActions: recentActions.rows.map(row => ({
          actionId: String(row.actionId), kind: row.kind as 'task' | 'attention', title: String(row.title),
          customerId: String(row.customerId), customerName: String(row.customerName),
          contactId: row.contactId === null ? null : number(row.contactId), contactName: row.contactName ? String(row.contactName) : null,
          dueAt: iso(row.dueAt), occurredAt: new Date(row.occurredAt).toISOString(), priority: row.priority as MailPriority,
        })),
        attention: attention.rows.map(row => ({
          itemId: String(row.itemId), memberUserId: String(row.memberUserId), memberName: String(row.memberName),
          customerId: String(row.customerId), customerName: String(row.customerName), contactId: number(row.contactId),
          contactName: String(row.contactName ?? ''), reason: String(row.reason), priority: row.priority as MailPriority,
          status: String(row.status), note: row.note ? String(row.note) : null, updatedAt: new Date(row.updatedAt).toISOString(),
        })) satisfies TeamMonitoringAttentionSummary[],
        recentMail: (recentMail.rows as MailRow[]).map(mail),
      });
    });
  }

  contact(tokenHash: string, contactId: number, customerId: string, limit: number, offset: number): Promise<Result<TeamMonitoringContactSummary>> {
    return this.audited(tokenHash, async (client, actor) => {
      if (!await this.accessibleContact(client, actor, contactId, customerId)) return failure('NOT_FOUND', '联系人不存在或不在监控范围');
      const row = (await client.query(`SELECT cc.contact_id AS "contactId",cc.customer_id AS "customerId",
        company.id AS "companyId",company.name AS "companyName",
        COALESCE(NULLIF(concat_ws(' ',contact.first_name,contact.last_name),''),contact.email,'') AS name,
        contact.email,COALESCE(company.country,contact.country) AS country,contact.title,
        customer.relationship_stage AS stage,contact.crm_touch_status AS "touchStatus",
        COALESCE(own.owner_user_id,customer.owner_user_id) AS "ownerUserId",
        owner.display_name AS "ownerName",customer.origin,
        contact.created_at AS "createdAt",contact.updated_at AS "updatedAt"
        FROM crm_customer_contacts cc
        JOIN contacts contact ON contact.id=cc.contact_id AND contact.crm_deleted_at IS NULL
        JOIN crm_customers customer ON customer.customer_id=cc.customer_id
        JOIN companies company ON company.id=customer.company_id AND company.crm_deleted_at IS NULL
        LEFT JOIN crm_contact_ownership own ON own.contact_id=cc.contact_id
          AND own.customer_id=cc.customer_id AND own.ended_at IS NULL
        LEFT JOIN public.identity_users owner ON owner.user_id=COALESCE(own.owner_user_id,customer.owner_user_id)
        WHERE cc.contact_id=$1 AND cc.customer_id=$2 LIMIT 1`, [contactId, customerId])).rows[0];
      if (!row) return failure('NOT_FOUND', '联系人不存在或不在监控范围');
      const auditId = await this.audit(client, actor, 'contact', String(contactId), contactId, customerId, null);
      const total = await client.query('SELECT count(*)::int AS total FROM crm_contact_mail_events WHERE contact_id=$1 AND customer_id=$2', [contactId, customerId]);
      const mailRows = await client.query(`SELECT ${MAIL_SUMMARY_SELECT}
        FROM crm_contact_mail_events event
        LEFT JOIN LATERAL (
          SELECT analysis.* FROM crm_contact_mail_analyses analysis
          WHERE analysis.event_id=event.event_id AND analysis.is_current
          ORDER BY analysis.created_at DESC,analysis.analysis_id DESC LIMIT 1
        ) analysis ON true
        WHERE event.contact_id=$1 AND event.customer_id=$2
        ORDER BY event.occurred_at DESC,event.event_id DESC LIMIT $3 OFFSET $4`, [contactId, customerId, limit, offset]);
      return success({
        auditId,
        scope: actor.scope,
        contactId: number(row.contactId), customerId: String(row.customerId),
        companyId: number(row.companyId), companyName: String(row.companyName), name: String(row.name),
        email: row.email ? String(row.email) : null, country: row.country ? String(row.country) : null,
        title: row.title ? String(row.title) : null, stage: row.stage, touchStatus: row.touchStatus,
        ownerUserId: row.ownerUserId ? String(row.ownerUserId) : null, ownerName: row.ownerName ? String(row.ownerName) : null,
        origin: row.origin, createdAt: new Date(row.createdAt).toISOString(), updatedAt: new Date(row.updatedAt).toISOString(),
        mail: { items: (mailRows.rows as MailRow[]).map(mail), total: number(total.rows[0].total) },
      });
    });
  }

  mail(tokenHash: string, eventId: string, contactId: number, customerId: string): Promise<Result<TeamMonitoringMailDetail>> {
    return this.audited(tokenHash, async (client, actor) => {
      if (!await this.accessibleContact(client, actor, contactId, customerId)) return failure('NOT_FOUND', '邮件不存在或不在监控范围');
      const row = (await client.query(`SELECT ${MAIL_SUMMARY_SELECT}
        FROM crm_contact_mail_events event
        LEFT JOIN LATERAL (
          SELECT analysis.* FROM crm_contact_mail_analyses analysis
          WHERE analysis.event_id=event.event_id AND analysis.is_current
          ORDER BY analysis.created_at DESC,analysis.analysis_id DESC LIMIT 1
        ) analysis ON true
        WHERE event.event_id=$1 AND event.contact_id=$2 AND event.customer_id=$3 LIMIT 1`,
      [eventId, contactId, customerId])).rows[0] as MailRow | undefined;
      if (!row) return failure('NOT_FOUND', '邮件不存在或不在监控范围');
      const auditId = await this.audit(client, actor, 'mail', eventId, contactId, customerId, eventId);
      return success({ auditId, scope: actor.scope, mail: mail(row) });
    });
  }
}
