import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { failure, success, type LogSink, type Result } from '../../core/crm';
import {
  TEAM_ATTENTION_EVENTS,
  canTransitionTeamAttention,
  type TeamAttentionCreate,
  type TeamAttentionItem,
  type TeamAttentionPage,
  type TeamAttentionQuery,
  type TeamAttentionRepository,
  type TeamAttentionScope,
  type TeamAttentionStatus,
  type TeamAttentionTransition,
} from '../../core/team-attention';
import { authorizeLeadActor, type LeadActor } from './lead-repository';
import { assertCenterDatabasePool } from './config';
import { ensureTeamAttentionSchemaIn } from './team-attention-schema';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

interface ItemRow {
  itemId:string; targetMemberUserId:string; targetMemberName:string;
  sourceSupervisorUserId:string; sourceSupervisorName:string;
  customerId:string; customerName:string; contactId:number; contactName:string; contactEmail:string|null;
  mailEventId:string|null; analysisId:string|null; reason:TeamAttentionItem['reason']; priority:TeamAttentionItem['priority'];
  status:TeamAttentionStatus; note:string|null; result:string|null; version:number;
  createdAt:Date|string; updatedAt:Date|string; acknowledgedAt:Date|string|null; resolvedAt:Date|string|null; dismissedAt:Date|string|null;
}

const ITEM_COLUMNS = `i.item_id AS "itemId",i.target_member_user_id AS "targetMemberUserId",target.display_name AS "targetMemberName",i.source_supervisor_user_id AS "sourceSupervisorUserId",source.display_name AS "sourceSupervisorName",i.customer_id AS "customerId",co.name AS "customerName",i.contact_id AS "contactId",COALESCE(NULLIF(concat_ws(' ',ct.first_name,ct.last_name),''),NULLIF(ct.email,''),'联系人') AS "contactName",ct.email AS "contactEmail",i.mail_event_id AS "mailEventId",i.analysis_id AS "analysisId",i.reason,i.priority,i.status,i.note,i.result,i.version,i.created_at AS "createdAt",i.updated_at AS "updatedAt",i.acknowledged_at AS "acknowledgedAt",i.resolved_at AS "resolvedAt",i.dismissed_at AS "dismissedAt"`;
const ITEM_JOINS = `FROM crm_team_attention_items i JOIN public.identity_users target ON target.user_id=i.target_member_user_id JOIN public.identity_users source ON source.user_id=i.source_supervisor_user_id JOIN crm_customers c ON c.customer_id=i.customer_id JOIN companies co ON co.id=c.company_id JOIN contacts ct ON ct.id=i.contact_id`;

function iso(value: Date|string): string { return new Date(value).toISOString(); }
function optionalIso(value: Date|string|null): string|null { return value ? new Date(value).toISOString() : null; }
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

function oversight(actor: LeadActor): boolean {
  return actor.roles.includes('admin') || actor.roles.includes('operations');
}

async function directReport(db: PoolClient, supervisorUserId: string, targetUserId: string): Promise<boolean> {
  const row = await db.query(`SELECT 1 FROM crm_org_assignments target JOIN crm_org_units team ON team.unit_id=target.unit_id AND team.kind='sales_team' JOIN crm_org_assignments leader ON leader.unit_id=target.unit_id AND leader.role='leader' WHERE target.user_id=$1 AND target.role='member' AND leader.user_id=$2 LIMIT 1`, [targetUserId, supervisorUserId]);
  return row.rowCount === 1;
}

async function hasDirectReports(db: PoolClient, supervisorUserId: string): Promise<boolean> {
  const row = await db.query(`SELECT 1 FROM crm_org_assignments leader JOIN crm_org_units team ON team.unit_id=leader.unit_id AND team.kind='sales_team' JOIN crm_org_assignments member ON member.unit_id=leader.unit_id AND member.role='member' WHERE leader.user_id=$1 AND leader.role='leader' LIMIT 1`, [supervisorUserId]);
  return row.rowCount === 1;
}

async function actorScope(db: PoolClient, actor: LeadActor): Promise<TeamAttentionScope> {
  if (oversight(actor)) return 'oversight';
  return await hasDirectReports(db, actor.userId) ? 'supervisor' : 'member';
}

function visibilitySql(scope: TeamAttentionScope): string {
  if (scope === 'oversight') return '$1::uuid IS NOT NULL';
  if (scope === 'member') return 'i.target_member_user_id=$1';
  return `EXISTS(SELECT 1 FROM crm_org_assignments target JOIN crm_org_units team ON team.unit_id=target.unit_id AND team.kind='sales_team' JOIN crm_org_assignments leader ON leader.unit_id=target.unit_id AND leader.role='leader' WHERE target.user_id=i.target_member_user_id AND target.role='member' AND leader.user_id=$1)`;
}

function mapped(row: ItemRow, scope: TeamAttentionScope): TeamAttentionItem {
  const supervisor = scope === 'supervisor';
  const member = scope === 'member' && row.status !== 'resolved' && row.status !== 'dismissed';
  return {
    ...row,
    createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt),
    acknowledgedAt: optionalIso(row.acknowledgedAt), resolvedAt: optionalIso(row.resolvedAt), dismissedAt: optionalIso(row.dismissedAt),
    canAcknowledge: supervisor && row.status === 'open',
    canDismiss: supervisor && (row.status === 'open' || row.status === 'acknowledged'),
    canResolve: member,
  };
}

async function notifyIn(db: PoolClient, eventType: string, actorId: string, item: ItemRow, recipients: string[]): Promise<void> {
  const unique = [...new Set(recipients)];
  if (!unique.length) return;
  const event = await db.query(`INSERT INTO public.identity_outbox(event_type,user_id,product_id,revision,customer_id,payload,recipient_user_ids) VALUES($1,$2,'crm',$3,$4,$5,$6::uuid[]) RETURNING event_id`, [eventType, actorId, item.version, item.customerId, JSON.stringify({ attentionItemId:item.itemId, attentionVersion:item.version, attentionStatus:item.status, targetMemberUserId:item.targetMemberUserId, sourceSupervisorUserId:item.sourceSupervisorUserId, reason:item.reason }), unique]);
  await db.query('INSERT INTO crm_team_attention_notifications(item_id,item_version,status,event_id,recipient_user_ids) VALUES($1,$2,$3,$4,$5::uuid[])', [item.itemId, item.version, item.status, event.rows[0].event_id, unique]);
}

export class PostgresTeamAttentionRepository implements TeamAttentionRepository {
  constructor(private readonly pool: Pool, private readonly log: LogSink) { assertCenterDatabasePool(pool); }

  private async tx<T>(work:(db: PoolClient) => Promise<Result<T>>): Promise<Result<T>> {
    let db: PoolClient | undefined;
    try {
      db = await this.pool.connect(); await db.query('BEGIN');
      const result = await work(db); await db.query(result.ok ? 'COMMIT' : 'ROLLBACK'); return result;
    } catch (error) {
      if (db) try { await db.query('ROLLBACK'); } catch { this.log.write('ERROR', 'team-attention.rollback', '关注项回滚失败'); }
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'UNKNOWN';
      this.log.write('ERROR', 'team-attention.pg', `关注项数据库操作失败 code=${code} message=${error instanceof Error ? error.message : 'unknown'}`);
      return failure('DATABASE_ERROR', '团队关注服务暂不可用');
    } finally { db?.release(); }
  }

  async migrate(): Promise<Result<void>> {
    return this.tx(async db => ensureTeamAttentionSchemaIn(db));
  }

  private async one(db: PoolClient, actor: LeadActor, scope: TeamAttentionScope, itemId: string): Promise<Result<TeamAttentionItem>> {
    const row = (await db.query(`SELECT ${ITEM_COLUMNS} ${ITEM_JOINS} WHERE i.item_id=$1`, [itemId])).rows[0] as ItemRow | undefined;
    if (!row) return failure('NOT_FOUND', '关注项不存在');
    const allowed = scope === 'oversight' || (scope === 'member' && row.targetMemberUserId === actor.userId) || (scope === 'supervisor' && await directReport(db, actor.userId, row.targetMemberUserId));
    return allowed ? success(mapped(row, scope)) : failure('NOT_FOUND', '关注项不存在');
  }

  private async cached<T>(db: PoolClient, actor: LeadActor, operation: string, input: { idempotencyKey:string }, work:() => Promise<Result<T>>): Promise<Result<T>> {
    const requestDigest = digest(input), old = await db.query('SELECT digest,response FROM crm_team_attention_idempotency WHERE actor_id=$1 AND operation=$2 AND key=$3', [actor.userId, operation, input.idempotencyKey]);
    if (old.rows.length) return old.rows[0].digest !== requestDigest ? failure('CONFLICT', '幂等键已用于不同请求') : success(old.rows[0].response as T);
    const result = await work();
    if (result.ok) await db.query('INSERT INTO crm_team_attention_idempotency(actor_id,operation,key,digest,response) VALUES($1,$2,$3,$4,$5)', [actor.userId, operation, input.idempotencyKey, requestDigest, JSON.stringify(result.data)]);
    return result;
  }

  list(tokenHash: string, query: TeamAttentionQuery): Promise<Result<TeamAttentionPage>> {
    return this.tx(async db => {
      const actor = await authorizeLeadActor(db, tokenHash); if (!actor) return failure('UNAUTHORIZED', 'CRM会话或产品准入已失效');
      const scope = await actorScope(db, actor), visible = visibilitySql(scope);
      const filters = `${visible} AND ($2::text IS NULL OR i.reason=$2) AND ($3::uuid IS NULL OR i.target_member_user_id=$3)`;
      const summary = await db.query(`SELECT count(*) FILTER(WHERE ($4::text IS NULL OR i.status=$4))::int AS total,count(*) FILTER(WHERE i.status='open')::int AS open,count(*) FILTER(WHERE i.status='acknowledged')::int AS acknowledged,count(*) FILTER(WHERE i.status='resolved')::int AS resolved,count(*) FILTER(WHERE i.status='dismissed')::int AS dismissed ${ITEM_JOINS} WHERE ${filters}`, [actor.userId, query.reason ?? null, query.targetMemberUserId ?? null, query.status ?? null]);
      const rows = await db.query(`SELECT ${ITEM_COLUMNS} ${ITEM_JOINS} WHERE ${filters} AND ($4::text IS NULL OR i.status=$4) ORDER BY CASE i.status WHEN 'open' THEN 0 WHEN 'acknowledged' THEN 1 ELSE 2 END,CASE i.priority WHEN 'urgent' THEN 0 WHEN 'important' THEN 1 ELSE 2 END,i.updated_at DESC,i.item_id LIMIT $5 OFFSET $6`, [actor.userId, query.reason ?? null, query.targetMemberUserId ?? null, query.status ?? null, query.limit, query.offset]);
      const s = summary.rows[0];
      return success({ scope, total:Number(s.total), counts:{ open:Number(s.open), acknowledged:Number(s.acknowledged), resolved:Number(s.resolved), dismissed:Number(s.dismissed) }, items:rows.rows.map(row => mapped(row as ItemRow, scope)) });
    });
  }

  create(tokenHash: string, input: TeamAttentionCreate): Promise<Result<TeamAttentionItem>> {
    return this.tx(async db => {
      const actor = await authorizeLeadActor(db, tokenHash); if (!actor) return failure('UNAUTHORIZED', 'CRM会话或产品准入已失效');
      if (oversight(actor) || !actor.roles.includes('sales') || !actor.capabilities.includes('leads.develop')) return failure('FORBIDDEN', '只有直属负责人可以创建关注项');
      if (!await directReport(db, actor.userId, input.targetMemberUserId)) return failure('FORBIDDEN', '只能关注自己的直属成员');
      const target = await db.query(`SELECT 1 FROM public.identity_users u JOIN public.identity_product_access a ON a.user_id=u.user_id AND a.product_id='crm' AND a.active JOIN public.identity_product_grants g ON g.user_id=u.user_id AND g.product_id='crm' AND g.role='sales' AND g.active WHERE u.user_id=$1 AND u.active AND NOT u.must_change_password`,[input.targetMemberUserId]);
      if (!target.rowCount) return failure('CONFLICT', '目标成员已停用或失去权限');
      const contact = await db.query(`SELECT 1 FROM crm_customer_contacts cc JOIN contacts ct ON ct.id=cc.contact_id AND ct.crm_deleted_at IS NULL JOIN crm_customers c ON c.customer_id=cc.customer_id JOIN companies co ON co.id=c.company_id AND co.crm_deleted_at IS NULL LEFT JOIN crm_contact_ownership own ON own.contact_id=ct.id AND own.customer_id=c.customer_id AND own.ended_at IS NULL WHERE cc.customer_id=$1 AND cc.contact_id=$2 AND COALESCE(own.owner_user_id,c.owner_user_id,c.created_by)=$3`,[input.customerId,input.contactId,input.targetMemberUserId]);
      if (!contact.rowCount) return failure('FORBIDDEN', '客户或联系人不在目标成员范围内');
      if (input.mailEventId) {
        const mail = await db.query('SELECT 1 FROM crm_contact_mail_events WHERE event_id=$1 AND actor_id=$2 AND customer_id=$3 AND contact_id=$4',[input.mailEventId,input.targetMemberUserId,input.customerId,input.contactId]);
        if (!mail.rowCount) return failure('INVALID_INPUT', '邮件证据不属于目标成员联系人');
      }
      if (input.analysisId) {
        const analysis = await db.query('SELECT 1 FROM crm_contact_mail_analyses WHERE analysis_id=$1 AND actor_id=$2 AND customer_id=$3 AND contact_id=$4',[input.analysisId,input.targetMemberUserId,input.customerId,input.contactId]);
        if (!analysis.rowCount) return failure('INVALID_INPUT', '分析证据不属于目标成员联系人');
      }
      return this.cached(db, actor, 'team-attention:create', input, async () => {
        const active = await db.query("SELECT 1 FROM crm_team_attention_items WHERE target_member_user_id=$1 AND customer_id=$2 AND contact_id=$3 AND reason=$4 AND status IN ('open','acknowledged')",[input.targetMemberUserId,input.customerId,input.contactId,input.reason]);
        if (active.rowCount) return failure('CONFLICT', '该成员已有同类未关闭关注项');
        const inserted = await db.query(`INSERT INTO crm_team_attention_items(target_member_user_id,source_supervisor_user_id,customer_id,contact_id,mail_event_id,analysis_id,reason,priority,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING item_id`,[input.targetMemberUserId,actor.userId,input.customerId,input.contactId,input.mailEventId??null,input.analysisId??null,input.reason,input.priority,input.note?.trim()||null]);
        const itemId=String(inserted.rows[0].item_id);
        await db.query("INSERT INTO crm_team_attention_audits(item_id,item_version,actor_id,action,from_status,to_status,note) VALUES($1,1,$2,'created',NULL,'open',$3)",[itemId,actor.userId,input.note?.trim()||null]);
        const row=(await db.query(`SELECT ${ITEM_COLUMNS} ${ITEM_JOINS} WHERE i.item_id=$1`,[itemId])).rows[0] as ItemRow;
        await notifyIn(db,TEAM_ATTENTION_EVENTS.opened,actor.userId,row,[input.targetMemberUserId,actor.userId]);
        return success(mapped(row,'supervisor'));
      });
    });
  }

  transition(tokenHash: string, input: TeamAttentionTransition): Promise<Result<TeamAttentionItem>> {
    return this.tx(async db => {
      const actor = await authorizeLeadActor(db, tokenHash); if (!actor) return failure('UNAUTHORIZED', 'CRM会话或产品准入已失效');
      if (oversight(actor)) return failure('FORBIDDEN', '管理角色只能查看关注项');
      const initial=(await db.query('SELECT target_member_user_id FROM crm_team_attention_items WHERE item_id=$1',[input.itemId])).rows[0];
      if (!initial) return failure('NOT_FOUND', '关注项不存在');
      const isTarget=String(initial.target_member_user_id)===actor.userId;
      if (input.action==='resolve' ? !isTarget : !await directReport(db,actor.userId,String(initial.target_member_user_id))) return failure('FORBIDDEN', input.action==='resolve'?'只能完成自己的关注项':'只能处理直属成员关注项');
      return this.cached(db,actor,`team-attention:${input.action}:${input.itemId}`,input,async()=>{
        const row=(await db.query(`SELECT ${ITEM_COLUMNS} ${ITEM_JOINS} WHERE i.item_id=$1 FOR UPDATE OF i`,[input.itemId])).rows[0] as ItemRow|undefined;
        if(!row)return failure('NOT_FOUND','关注项不存在');
        if(row.version!==input.expectedVersion)return failure('CONFLICT','关注项状态已变化，请刷新后重试');
        if(!canTransitionTeamAttention(row.status,input.action))return failure('CONFLICT','关注项当前状态不可操作');
        if(input.action==='resolve'&&!input.result?.trim())return failure('INVALID_INPUT','请填写处理结果');
        const next:TeamAttentionStatus=input.action==='acknowledge'?'acknowledged':input.action==='dismiss'?'dismissed':'resolved';
        const updated=(await db.query(`UPDATE crm_team_attention_items SET status=$2,result=$3,version=version+1,updated_at=clock_timestamp(),acknowledged_at=CASE WHEN $2='acknowledged' THEN clock_timestamp() ELSE acknowledged_at END,resolved_at=CASE WHEN $2='resolved' THEN clock_timestamp() ELSE resolved_at END,dismissed_at=CASE WHEN $2='dismissed' THEN clock_timestamp() ELSE dismissed_at END WHERE item_id=$1 AND version=$4 RETURNING item_id`,[input.itemId,next,input.action==='acknowledge'?null:input.result?.trim()||null,input.expectedVersion]));
        if(!updated.rowCount)return failure('CONFLICT','关注项状态已变化，请刷新后重试');
        const current=(await db.query(`SELECT ${ITEM_COLUMNS} ${ITEM_JOINS} WHERE i.item_id=$1`,[input.itemId])).rows[0] as ItemRow;
        await db.query(`INSERT INTO crm_team_attention_audits(item_id,item_version,actor_id,action,from_status,to_status,result) VALUES($1,$2,$3,$4,$5,$6,$7)`,[input.itemId,current.version,actor.userId,next,row.status,next,input.result?.trim()||null]);
        const leader=(await db.query(`SELECT leader.user_id FROM crm_org_assignments target JOIN crm_org_units team ON team.unit_id=target.unit_id AND team.kind='sales_team' JOIN crm_org_assignments leader ON leader.unit_id=target.unit_id AND leader.role='leader' WHERE target.user_id=$1 AND target.role='member'`,[current.targetMemberUserId])).rows.map(value=>String(value.user_id));
        const recipients=input.action==='resolve'?[...leader,current.sourceSupervisorUserId]:[current.targetMemberUserId];
        await notifyIn(db,next==='acknowledged'?TEAM_ATTENTION_EVENTS.acknowledged:next==='resolved'?TEAM_ATTENTION_EVENTS.resolved:TEAM_ATTENTION_EVENTS.dismissed,actor.userId,current,recipients);
        return success(mapped(current,isTarget?'member':'supervisor'));
      });
    });
  }
}
