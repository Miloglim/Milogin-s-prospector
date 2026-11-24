import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { failure, success, type LogSink, type Result } from '../../core/crm';
import type { AiProposal, CreateAiProposalInput, SalesCase, SalesCaseDetail, SalesCaseEvent } from '../../core/sales-case';
import { canActOnProposal, canTransitionSalesCase, DEAL_WON_EVENT, proposalActionState, type SalesCaseState } from '../../core/sales-case';
import { SALES_CASE_PROPOSAL_SCHEMA_SQL, SALES_CASE_PROPOSAL_SCHEMA_VERSION, SALES_CASE_SCHEMA_SQL, SALES_CASE_SCHEMA_VERSION, SALES_WORKFLOW_INTEGRITY_SQL, SALES_WORKFLOW_INTEGRITY_VERSION } from './sales-case-schema';
import { customerStatusStateIn, derivedCustomerStatusIn, recordCustomerStatusEventIn } from './customer-status-repository';
import { customerStatusIsRegression, salesCaseCustomerStatus } from '../../core/customer-status';
import { migrateCustomerStatusSchemaIn } from './customer-status-schema';

type ActorRole = 'admin' | 'operations' | 'sales' | 'auditor';
interface Actor { userId: string; identityAdmin: boolean; roles: ActorRole[] }
interface CustomerScope { customerId: string; origin: string; ownerUserId: string | null; createdBy: string }

const CASE_COLUMNS = `c.case_id AS "caseId",c.customer_id AS "customerId",c.contact_id AS "contactId",c.owner_user_id AS "ownerUserId",c.state,c.source,c.verified_at AS "verifiedAt",c.latest_message_key AS "latestMessageKey",c.latest_summary AS "latestSummary",c.next_action AS "nextAction",c.next_action_at AS "nextActionAt",c.stop_reason AS "stopReason",c.version,c.created_at AS "createdAt",c.updated_at AS "updatedAt"`;

function iso(value: unknown): string | null { return value instanceof Date ? value.toISOString() : typeof value === 'string' ? new Date(value).toISOString() : null; }
function mapCase(row: Record<string, unknown>): SalesCase {
  return {
    caseId: String(row.caseId), customerId: String(row.customerId), contactId: Number(row.contactId), ownerUserId: String(row.ownerUserId),
    state: String(row.state) as SalesCase['state'], source: String(row.source), verifiedAt: iso(row.verifiedAt), latestMessageKey: row.latestMessageKey ? String(row.latestMessageKey) : null,
    latestSummary: row.latestSummary ? String(row.latestSummary) : null, nextAction: row.nextAction ? String(row.nextAction) : null, nextActionAt: iso(row.nextActionAt), stopReason: row.stopReason ? String(row.stopReason) : null,
    version: Number(row.version), createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)!,
  };
}
function mapProposal(row: Record<string, any>): AiProposal {
  return {
    proposalId: String(row.proposal_id), caseId: String(row.case_id), proposalType: row.proposal_type, status: row.status,
    payload: row.payload_json || {}, evidence: row.evidence_json || [], confidence: Number(row.confidence), model: row.model,
    version: row.version, expiresAt: iso(row.expires_at), actedBy: row.acted_by ? String(row.acted_by) : null, actedAt: iso(row.acted_at), createdAt: iso(row.created_at)!,
  };
}

function mapEvent(row: Record<string, any>): SalesCaseEvent {
  return {
    eventId: Number(row.event_id), caseId: String(row.case_id), eventKey: String(row.event_key),
    eventType: row.event_type, source: row.source, payload: row.payload_json || {},
    evidence: row.evidence_json || [], actorUserId: row.actor_user_id ? String(row.actor_user_id) : null,
    createdAt: iso(row.created_at)!,
  };
}

/** Import and assignment transactions use the same idempotent case projection as the HTTP API. */
export async function ensureSalesCaseIn(
  client: PoolClient,
  input: { customerId: string; contactId: number; ownerUserId: string; source: string; summary?: string | null },
): Promise<{ caseId: string; created: boolean }> {
  const existing = await client.query(
    `SELECT case_id FROM crm_sales_cases WHERE contact_id=$1 AND owner_user_id=$2 AND state NOT IN ('won','lost') FOR UPDATE`,
    [input.contactId, input.ownerUserId],
  );
  if (existing.rows.length) return { caseId: String(existing.rows[0].case_id), created: false };
  const caseId = randomUUID();
  await client.query(
    `INSERT INTO crm_sales_cases(case_id,customer_id,contact_id,owner_user_id,state,source,verified_at,latest_summary,next_action)
     VALUES($1,$2,$3,$4,'lead_verified',$5,clock_timestamp(),$6,'准备客户开发任务')`,
    [caseId, input.customerId, input.contactId, input.ownerUserId, input.source, input.summary || null],
  );
  await client.query(
    `INSERT INTO crm_case_events(case_id,event_key,event_type,source,payload_json,evidence_json,actor_user_id)
     VALUES($1,$2,'lead.verified','rule',$3,'[]'::jsonb,$4) ON CONFLICT(event_key) DO NOTHING`,
    [caseId, `lead.verified:${caseId}`, JSON.stringify({ contactId: input.contactId, customerId: input.customerId, source: input.source }), input.ownerUserId],
  );
  return { caseId, created: true };
}

export async function applyDealWonProposalIn(
  client: PoolClient,
  input: {
    caseId: string; customerId: string; contactId: number; ownerUserId: string; actorUserId: string;
    messageKey: string; signalCode: string; summary: string; evidence: unknown[]; confidence: number;
  },
): Promise<{ proposalId: string; applied: boolean }> {
  const active = await client.query(
    `SELECT proposal_id FROM crm_ai_proposals WHERE case_id=$1 AND proposal_type='deal_won' AND status='applied_pending_confirmation' LIMIT 1 FOR UPDATE`,
    [input.caseId],
  );
  if (active.rows.length) return { proposalId: String(active.rows[0].proposal_id), applied: false };
  const current = await client.query('SELECT state,version FROM crm_sales_cases WHERE case_id=$1 FOR UPDATE', [input.caseId]);
  const row = current.rows[0];
  if (!row || ['won', 'lost'].includes(String(row.state))) return { proposalId: '', applied: false };
  const proposalId = randomUUID();
  const previousState = String(row.state);
  const payload = { previousState, signalCode: input.signalCode, summary: input.summary, messageKey: input.messageKey, customerId: input.customerId, contactId: input.contactId };
  await client.query(
    `INSERT INTO crm_ai_proposals(proposal_id,case_id,proposal_type,status,payload_json,evidence_json,confidence,model,version)
     VALUES($1,$2,'deal_won','applied_pending_confirmation',$3::jsonb,$4::jsonb,$5,'center-managed',$6)`,
    [proposalId, input.caseId, JSON.stringify(payload), JSON.stringify(input.evidence), input.confidence, input.messageKey],
  );
  const nextVersion = Number(row.version) + 1;
  await client.query(
    `UPDATE crm_sales_cases SET state='won',latest_message_key=$2,latest_summary=$3,next_action='核对成交信息；不符合请取消 AI 成交记录',stop_reason='ai_deal_won_pending_confirmation',version=$4,updated_at=clock_timestamp() WHERE case_id=$1`,
    [input.caseId, input.messageKey, input.summary, nextVersion],
  );
  await client.query(
    `INSERT INTO crm_case_events(case_id,event_key,event_type,source,payload_json,evidence_json,actor_user_id)
     VALUES($1,$2,'case.won','ai',$3::jsonb,$4::jsonb,$5) ON CONFLICT(event_key) DO NOTHING`,
    [input.caseId, `deal-won:${input.caseId}:${input.messageKey}`, JSON.stringify({ proposalId, previousState, signalCode: input.signalCode }), JSON.stringify(input.evidence), input.actorUserId],
  );
  const previousStatus=(await customerStatusStateIn(client,input.customerId))?.status??await derivedCustomerStatusIn(client,input.customerId)??'uncontacted';
  if(!customerStatusIsRegression(previousStatus,'won_pending'))await recordCustomerStatusEventIn(client,{eventKey:`deal-won:${input.caseId}:${input.messageKey}`,customerId:input.customerId,contactId:input.contactId,status:'won_pending',previousStatus,source:'ai',signal:'deal_won',actorUserId:input.actorUserId,reason:input.summary,evidence:input.evidence,payload:{caseId:input.caseId,proposalId,previousState,signalCode:input.signalCode},occurredAt:new Date()});
  const leaders = await client.query(
    `SELECT DISTINCT leader.user_id
     FROM crm_org_assignments member
     JOIN crm_org_units unit ON unit.unit_id=member.unit_id AND unit.kind='sales_team' AND unit.dissolved_at IS NULL
     JOIN crm_org_assignments leader ON leader.unit_id=member.unit_id AND leader.role='leader' AND leader.ended_at IS NULL
     WHERE member.user_id=$1 AND member.ended_at IS NULL`,
    [input.ownerUserId],
  );
  const operations = await client.query(
    `SELECT DISTINCT grants.user_id FROM public.identity_product_grants grants
     JOIN public.identity_product_access access USING(user_id,product_id)
     WHERE grants.product_id='crm' AND grants.role='operations' AND grants.active AND access.active`,
  );
  const recipients = [...new Set([input.actorUserId, input.ownerUserId, ...leaders.rows.map(row => String(row.user_id)), ...operations.rows.map(row => String(row.user_id))])].sort();
  await client.query(
    `INSERT INTO public.identity_outbox(event_type,user_id,product_id,revision,customer_id,payload,recipient_user_ids)
     VALUES($1,$2,'crm',$3,$4,$5::jsonb,$6::uuid[])`,
    [DEAL_WON_EVENT, input.actorUserId, nextVersion, input.customerId, JSON.stringify({ caseId: input.caseId, proposalId, customerId: input.customerId, contactId: input.contactId, signalCode: input.signalCode, summary: input.summary, version: nextVersion }), recipients],
  );
  return { proposalId, applied: true };
}

export class PostgresSalesCaseRepository {
  constructor(private readonly pool: Pool, private readonly log: LogSink) {}

  async migrate(): Promise<Result<void>> {
    const client = await this.pool.connect();
    try {
      const checksum = createHash('sha256').update(SALES_CASE_SCHEMA_SQL).digest('hex');
      const old = await client.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1', [SALES_CASE_SCHEMA_VERSION]);
      if (old.rows.length && old.rows[0].checksum !== checksum) return failure('CONFLICT', 'AI 销售工作流迁移校验不一致');
      if (!old.rows.length) {
        await client.query('BEGIN');
        try {
          await client.query(SALES_CASE_SCHEMA_SQL);
          await client.query('INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)', [SALES_CASE_SCHEMA_VERSION, checksum]);
          await client.query('COMMIT');
          this.log.write('INFO', 'sales-case.migrate', `迁移完成 version=${SALES_CASE_SCHEMA_VERSION}`);
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
      const proposalChecksum = createHash('sha256').update(SALES_CASE_PROPOSAL_SCHEMA_SQL).digest('hex');
      const proposalOld = await client.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1', [SALES_CASE_PROPOSAL_SCHEMA_VERSION]);
      if (proposalOld.rows.length && proposalOld.rows[0].checksum !== proposalChecksum) return failure('CONFLICT', 'AI 成交建议迁移校验不一致');
      if (!proposalOld.rows.length) {
        await client.query('BEGIN');
        try {
          await client.query(SALES_CASE_PROPOSAL_SCHEMA_SQL);
          await client.query('INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)', [SALES_CASE_PROPOSAL_SCHEMA_VERSION, proposalChecksum]);
          await client.query('COMMIT');
          this.log.write('INFO', 'sales-case.migrate', `迁移完成 version=${SALES_CASE_PROPOSAL_SCHEMA_VERSION}`);
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
      const integrityChecksum = createHash('sha256').update(SALES_WORKFLOW_INTEGRITY_SQL).digest('hex');
      const integrityOld = await client.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1', [SALES_WORKFLOW_INTEGRITY_VERSION]);
      if (integrityOld.rows.length && integrityOld.rows[0].checksum !== integrityChecksum) return failure('CONFLICT', 'AI 销售工作流完整性迁移校验不一致');
      if (!integrityOld.rows.length) {
        await client.query('BEGIN');
        try {
          await client.query(SALES_WORKFLOW_INTEGRITY_SQL);
          await client.query('INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)', [SALES_WORKFLOW_INTEGRITY_VERSION, integrityChecksum]);
          await client.query('COMMIT');
          this.log.write('INFO', 'sales-case.migrate', `迁移完成 version=${SALES_WORKFLOW_INTEGRITY_VERSION}`);
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
      await client.query('BEGIN');
      try {
        const statusMigration = await migrateCustomerStatusSchemaIn(client);
        await client.query(statusMigration.ok ? 'COMMIT' : 'ROLLBACK');
        return statusMigration;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    } catch (error) {
      this.log.write('ERROR', 'sales-case.pg', `AI 销售工作流迁移失败 code=${(error as any)?.code || 'UNKNOWN'}`);
      return failure('DATABASE_ERROR', 'AI 销售工作流迁移失败');
    } finally { client.release(); }
  }

  private async actor(db: PoolClient, hash: string): Promise<Actor | null> {
    const result = await db.query(`SELECT u.user_id,u.identity_admin,ARRAY(SELECT g.role FROM public.identity_product_grants g WHERE g.user_id=u.user_id AND g.product_id='crm' AND g.active ORDER BY g.role) AS roles
      FROM public.identity_sessions s JOIN public.identity_users u USING(user_id)
      WHERE s.token_hash=$1 AND s.client='api' AND s.revoked_at IS NULL AND s.expires_at>now() AND u.active AND NOT u.must_change_password AND s.security_revision=u.security_revision`, [hash]);
    return result.rows.length ? { userId: String(result.rows[0].user_id), identityAdmin: Boolean(result.rows[0].identity_admin), roles: (result.rows[0].roles || []) as ActorRole[] } : null;
  }

  private canSee(actor: Actor, scope: CustomerScope): boolean {
    if (actor.identityAdmin || actor.roles.includes('admin')) return true;
    if (actor.roles.includes('operations') && scope.origin === 'operations') return true;
    return [scope.ownerUserId, scope.createdBy].includes(actor.userId);
  }

  async list(hash: string, limit: number, offset: number): Promise<Result<SalesCase[]>> {
    const client = await this.pool.connect();
    try {
      const actor = await this.actor(client, hash);
      if (!actor) return failure('UNAUTHORIZED', 'CRM 会话已失效');
      const admin = actor.identityAdmin || actor.roles.includes('admin');
      const operations = actor.roles.includes('operations');
      const visibility = admin ? 'TRUE' : operations ? `(customer.origin='operations' OR customer.owner_user_id=$1 OR customer.created_by=$1)` : '(customer.owner_user_id=$1 OR customer.created_by=$1)';
      const limitIndex = admin ? 1 : 2;
      const result = await client.query(`SELECT ${CASE_COLUMNS} FROM crm_sales_cases c JOIN crm_customers customer USING(customer_id) WHERE ${visibility} ORDER BY COALESCE(c.next_action_at,c.updated_at) DESC LIMIT $${limitIndex}::int OFFSET $${limitIndex + 1}::int`, admin ? [limit, offset] : [actor.userId, limit, offset]);
      return success(result.rows.map(mapCase));
    } catch (error) {
      this.log.write('ERROR', 'sales-case.pg', `销售 Case 列表失败 code=${(error as any)?.code || 'UNKNOWN'} message=${(error as any)?.message || ''}`);
      return failure('DATABASE_ERROR', '销售 Case 列表暂不可用');
    } finally { client.release(); }
  }

  async detail(hash: string, caseId: string): Promise<Result<SalesCase>> {
    const client = await this.pool.connect();
    try {
      const actor = await this.actor(client, hash);
      if (!actor) return failure('UNAUTHORIZED', 'CRM 会话已失效');
      const result = await client.query(`SELECT ${CASE_COLUMNS},customer.origin,customer.owner_user_id,customer.created_by FROM crm_sales_cases c JOIN crm_customers customer USING(customer_id) WHERE c.case_id=$1`, [caseId]);
      if (!result.rows.length) return failure('NOT_FOUND', '销售 Case 不存在');
      const row = result.rows[0];
      if (!this.canSee(actor, { customerId: String(row.customerId), origin: String(row.origin), ownerUserId: row.owner_user_id ? String(row.owner_user_id) : null, createdBy: String(row.created_by) })) return failure('NOT_FOUND', '销售 Case 不存在');
      return success(mapCase(row));
    } catch (error) {
      this.log.write('ERROR', 'sales-case.pg', `销售 Case 详情失败 code=${(error as any)?.code || 'UNKNOWN'}`);
      return failure('DATABASE_ERROR', '销售 Case 详情暂不可用');
    } finally { client.release(); }
  }

  async detailWithProposals(hash: string, caseId: string): Promise<Result<SalesCaseDetail>> {
    const client = await this.pool.connect();
    try {
      const actor = await this.actor(client, hash);
      if (!actor) return failure('UNAUTHORIZED', 'CRM 会话已失效');
      const row = (await client.query(
        `SELECT ${CASE_COLUMNS},customer.origin,customer.owner_user_id,customer.created_by
         FROM crm_sales_cases c JOIN crm_customers customer USING(customer_id) WHERE c.case_id=$1`,
        [caseId],
      )).rows[0];
      if (!row || !this.canSee(actor, {
        customerId: String(row.customerId), origin: String(row.origin),
        ownerUserId: row.owner_user_id ? String(row.owner_user_id) : null, createdBy: String(row.created_by),
      })) return failure('NOT_FOUND', '销售 Case 不存在');
      const [events, proposals] = await Promise.all([
        client.query('SELECT * FROM crm_case_events WHERE case_id=$1 ORDER BY created_at DESC,event_id DESC LIMIT 100', [caseId]),
        client.query('SELECT * FROM crm_ai_proposals WHERE case_id=$1 ORDER BY created_at DESC LIMIT 100', [caseId]),
      ]);
      return success({ case: mapCase(row), events: events.rows.map(mapEvent), proposals: proposals.rows.map(mapProposal) });
    } catch (error) {
      this.log.write('ERROR', 'sales-case.pg', `销售 Case 详情失败 code=${(error as any)?.code || 'UNKNOWN'}`);
      return failure('DATABASE_ERROR', '销售 Case 详情暂不可用');
    } finally { client.release(); }
  }

  async ensure(hash: string, contactId: number, customerId: string, source = 'inquiry'): Promise<Result<SalesCase>> {
    const client = await this.pool.connect();
    try {
      const actor = await this.actor(client, hash);
      if (!actor) return failure('UNAUTHORIZED', 'CRM 会话已失效');
      const contact = (await client.query(
        `SELECT customer.origin,customer.owner_user_id,customer.created_by,
                COALESCE((SELECT own.owner_user_id FROM crm_contact_ownership own
                  WHERE own.contact_id=ct.id AND own.customer_id=customer.customer_id AND own.ended_at IS NULL
                  ORDER BY own.started_at DESC,own.ownership_id DESC LIMIT 1),customer.owner_user_id) AS contact_owner
         FROM contacts ct
         JOIN crm_customer_contacts link ON link.contact_id=ct.id
         JOIN crm_customers customer ON customer.customer_id=link.customer_id
         WHERE ct.id=$1 AND customer.customer_id=$2`,
        [contactId, customerId],
      )).rows[0];
      if (!contact) return failure('NOT_FOUND', '联系人不存在');
      const scopeOwner = contact.contact_owner ? String(contact.contact_owner) : null;
      if (!this.canSee(actor, { customerId, origin: String(contact.origin), ownerUserId: scopeOwner, createdBy: String(contact.created_by) })) {
        return failure('NOT_FOUND', '联系人不存在');
      }
      const ownerUserId = scopeOwner || actor.userId;
      const ensured = await ensureSalesCaseIn(client, { customerId, contactId, ownerUserId, source });
      return this.detailByActor(client, ownerUserId, ensured.caseId);
    } catch (error) {
      this.log.write('ERROR', 'sales-case.pg', `销售 Case 确认失败 code=${(error as any)?.code || 'UNKNOWN'}`);
      return failure('DATABASE_ERROR', '销售 Case 暂不可用');
    } finally { client.release(); }
  }

  async listProposals(hash: string, caseId: string, status?: string): Promise<Result<AiProposal[]>> {
    const client = await this.pool.connect();
    try {
      const actor = await this.actor(client, hash);
      if (!actor) return failure('UNAUTHORIZED', 'CRM 会话已失效');
      const caseRow = (await client.query(
        `SELECT c.owner_user_id,customer.origin,customer.owner_user_id,customer.created_by
         FROM crm_sales_cases c JOIN crm_customers customer USING(customer_id) WHERE c.case_id=$1`,
        [caseId],
      )).rows[0];
      if (!caseRow || !this.canSee(actor, {
        customerId: caseId, origin: String(caseRow.origin),
        ownerUserId: caseRow.owner_user_id ? String(caseRow.owner_user_id) : null, createdBy: String(caseRow.created_by),
      })) return failure('NOT_FOUND', '销售 Case 不存在');
      const result = status
        ? await client.query('SELECT * FROM crm_ai_proposals WHERE case_id=$1 AND status=$2 ORDER BY created_at DESC', [caseId, status])
        : await client.query('SELECT * FROM crm_ai_proposals WHERE case_id=$1 ORDER BY created_at DESC', [caseId]);
      return success(result.rows.map(mapProposal));
    } catch (error) {
      this.log.write('ERROR', 'sales-case.pg', `建议列表失败 code=${(error as any)?.code || 'UNKNOWN'}`);
      return failure('DATABASE_ERROR', '建议列表暂不可用');
    } finally { client.release(); }
  }

  async proposal(hash: string, caseId: string, proposalId: string): Promise<Result<AiProposal>> {
    const proposals = await this.listProposals(hash, caseId);
    if (!proposals.ok) return proposals;
    const found = proposals.data.find(item => item.proposalId === proposalId);
    return found ? success(found) : failure('NOT_FOUND', '建议不存在');
  }

  async createProposal(hash: string, caseId: string, input: CreateAiProposalInput & { proposalId: string }): Promise<Result<AiProposal>> {
    const client = await this.pool.connect();
    try {
      const actor = await this.actor(client, hash);
      if (!actor) return failure('UNAUTHORIZED', 'CRM 会话已失效');
      const caseRow = (await client.query(
        `SELECT c.owner_user_id,customer.origin,customer.owner_user_id,customer.created_by
         FROM crm_sales_cases c JOIN crm_customers customer USING(customer_id) WHERE c.case_id=$1`,
        [caseId],
      )).rows[0];
      if (!caseRow || !this.canSee(actor, {
        customerId: caseId, origin: String(caseRow.origin),
        ownerUserId: caseRow.owner_user_id ? String(caseRow.owner_user_id) : null, createdBy: String(caseRow.created_by),
      })) return failure('NOT_FOUND', '销售 Case 不存在');
      const inserted = await client.query(
        `INSERT INTO crm_ai_proposals(proposal_id,case_id,proposal_type,status,payload_json,evidence_json,confidence,model,version,expires_at)
         VALUES($1,$2,$3,'pending',$4,$5,$6,$7,$8,$9)
         ON CONFLICT(proposal_id) DO UPDATE SET proposal_id=EXCLUDED.proposal_id
         RETURNING *`,
        [input.proposalId, caseId, input.proposalType, JSON.stringify(input.payload), JSON.stringify(input.evidence || []),
          input.confidence, input.model || null, input.version || null, input.expiresAt || null],
      );
      return success(mapProposal(inserted.rows[0]));
    } catch (error) {
      this.log.write('ERROR', 'sales-case.pg', `建议创建失败 code=${(error as any)?.code || 'UNKNOWN'}`);
      return failure('DATABASE_ERROR', '建议创建失败');
    } finally { client.release(); }
  }

  async create(actorUserId: string, input: { caseId: string; customerId: string; contactId: number; source: string; summary?: string; nextAction?: string; nextActionAt?: string }): Promise<Result<SalesCase>> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(`INSERT INTO crm_sales_cases(case_id,customer_id,contact_id,owner_user_id,state,source,latest_summary,next_action,next_action_at)
        VALUES($1,$2,$3,$4,'lead_pending',$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING case_id`, [input.caseId, input.customerId, input.contactId, actorUserId, input.source, input.summary || null, input.nextAction || '验证线索', input.nextActionAt || null]);
      if (!result.rows.length) return failure('CONFLICT', '该联系人已有开放销售 Case');
      return this.detailByActor(client, actorUserId, input.caseId);
    } catch (error) {
      this.log.write('ERROR', 'sales-case.pg', `销售 Case 创建失败 code=${(error as any)?.code || 'UNKNOWN'}`);
      return failure('DATABASE_ERROR', '销售 Case 创建失败');
    } finally { client.release(); }
  }

  private async detailByActor(client: PoolClient, userId: string, caseId: string): Promise<Result<SalesCase>> {
    const result = await client.query(`SELECT ${CASE_COLUMNS} FROM crm_sales_cases c WHERE c.case_id=$1 AND c.owner_user_id=$2`, [caseId, userId]);
    return result.rows.length ? success(mapCase(result.rows[0])) : failure('NOT_FOUND', '销售 Case 不存在');
  }

  async appendEvent(input: Omit<SalesCaseEvent, 'eventId' | 'createdAt'>): Promise<Result<void>> {
    try {
      await this.pool.query(`INSERT INTO crm_case_events(case_id,event_key,event_type,source,payload_json,evidence_json,actor_user_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(event_key) DO NOTHING`, [input.caseId, input.eventKey, input.eventType, input.source, JSON.stringify(input.payload), JSON.stringify(input.evidence), input.actorUserId]);
      return success(undefined);
    } catch (error) {
      this.log.write('ERROR', 'sales-case.pg', `Case 事件写入失败 code=${(error as any)?.code || 'UNKNOWN'}`);
      return failure('DATABASE_ERROR', 'Case 事件写入失败');
    }
  }

  async transition(hash: string, caseId: string, input: { state: SalesCaseState; nextAction?: string | null; summary?: string | null; eventType?: SalesCaseEvent['eventType']; payload?: Record<string, unknown>; evidence?: unknown[] }): Promise<Result<SalesCase>> {
    const client = await this.pool.connect();
    try {
      const actor = await this.actor(client, hash);
      if (!actor) return failure('UNAUTHORIZED', 'CRM 会话已失效');
      await client.query('BEGIN');
      const row = (await client.query(
        `SELECT c.case_id,c.customer_id,c.contact_id,c.state,c.owner_user_id,c.version,customer.origin,customer.owner_user_id AS customer_owner,customer.created_by
         FROM crm_sales_cases c JOIN crm_customers customer USING(customer_id) WHERE c.case_id=$1 FOR UPDATE OF c`,
        [caseId],
      )).rows[0];
      if (!row || !this.canSee(actor, { customerId: caseId, origin: String(row.origin), ownerUserId: row.customer_owner ? String(row.customer_owner) : null, createdBy: String(row.created_by) })) {
        await client.query('ROLLBACK'); return failure('NOT_FOUND', '销售 Case 不存在');
      }
      if (!canTransitionSalesCase(String(row.state) as SalesCaseState, input.state)) { await client.query('ROLLBACK'); return failure('CONFLICT', '销售 Case 状态不允许这样推进'); }
      await client.query(`UPDATE crm_sales_cases SET state=$2,next_action=COALESCE($3,next_action),latest_summary=COALESCE($4,latest_summary),version=version+1,updated_at=clock_timestamp() WHERE case_id=$1`, [caseId, input.state, input.nextAction ?? null, input.summary ?? null]);
      await client.query(`INSERT INTO crm_case_events(case_id,event_key,event_type,source,payload_json,evidence_json,actor_user_id) VALUES($1,$2,$3,'system',$4,$5,$6) ON CONFLICT(event_key) DO NOTHING`, [caseId, `${input.eventType || 'case'}:${caseId}:${Date.now()}`, input.eventType || 'proposal.accepted', JSON.stringify(input.payload || {}), JSON.stringify(input.evidence || []), actor.userId]);
      const nextStatus=salesCaseCustomerStatus(input.state);
      if(nextStatus){const previousStatus=(await customerStatusStateIn(client,String(row.customer_id)))?.status??await derivedCustomerStatusIn(client,String(row.customer_id))??'uncontacted';if(!customerStatusIsRegression(previousStatus,nextStatus))await recordCustomerStatusEventIn(client,{eventKey:`sales-case:${caseId}:${Number(row.version)+1}`,customerId:String(row.customer_id),contactId:Number(row.contact_id),status:nextStatus,previousStatus,source:'human',signal:'sales_case',actorUserId:actor.userId,reason:`Case 状态：${input.state}`,payload:{caseId,fromState:String(row.state),toState:input.state,eventType:input.eventType??null},occurredAt:new Date()});}
      const updated = await client.query(`SELECT ${CASE_COLUMNS} FROM crm_sales_cases c WHERE c.case_id=$1`, [caseId]);
      await client.query('COMMIT');
      return success(mapCase(updated.rows[0]));
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* transaction may already be closed */ }
      this.log.write('ERROR', 'sales-case.pg', `销售 Case 推进失败 code=${(error as any)?.code || 'UNKNOWN'}`);
      return failure('DATABASE_ERROR', '销售 Case 推进失败');
    } finally { client.release(); }
  }

  async actProposal(hash: string, caseId: string, proposalId: string, action: 'accept' | 'edit' | 'ignore' | 'cancel', payload?: Record<string, unknown>): Promise<Result<AiProposal>> {
    const client = await this.pool.connect();
    try {
      const actor = await this.actor(client, hash);
      if (!actor) return failure('UNAUTHORIZED', 'CRM 会话已失效');
      await client.query('BEGIN');
      const result = await client.query('SELECT * FROM crm_ai_proposals WHERE proposal_id=$1 FOR UPDATE', [proposalId]);
      if (!result.rows.length) { await client.query('ROLLBACK'); return failure('NOT_FOUND', '建议不存在'); }
      const proposal = result.rows[0];
      if (String(proposal.case_id) !== caseId) { await client.query('ROLLBACK'); return failure('NOT_FOUND', '建议不存在'); }
      const caseResult = await client.query(
        `SELECT c.customer_id,c.contact_id,c.owner_user_id,customer.origin,customer.owner_user_id,customer.created_by
         FROM crm_sales_cases c JOIN crm_customers customer USING(customer_id) WHERE c.case_id=$1 FOR UPDATE OF c`,
        [caseId],
      );
      if (!caseResult.rows.length) { await client.query('ROLLBACK'); return failure('NOT_FOUND', '建议不存在'); }
      const caseRow = caseResult.rows[0];
      if (!this.canSee(actor, {
        customerId: caseId, origin: String(caseRow.origin),
        ownerUserId: caseRow.owner_user_id ? String(caseRow.owner_user_id) : null,
        createdBy: String(caseRow.created_by),
      })) { await client.query('ROLLBACK'); return failure('FORBIDDEN', '无权处理该建议'); }
      if (!canActOnProposal(proposal.status)) { await client.query('ROLLBACK'); return failure('CONFLICT', '建议已处理'); }
      if (proposal.status === 'applied_pending_confirmation' && action !== 'cancel') { await client.query('ROLLBACK'); return failure('CONFLICT', '待确认成交只能取消'); }
      if (proposal.proposal_type === 'deal_won' && proposal.status === 'applied_pending_confirmation' && action === 'cancel') {
        const previousState = typeof proposal.payload_json?.previousState === 'string' ? proposal.payload_json.previousState : 'replied';
        const nextVersion = Number((await client.query('SELECT version FROM crm_sales_cases WHERE case_id=$1 FOR UPDATE', [caseId])).rows[0]?.version ?? 1) + 1;
        await client.query(`UPDATE crm_sales_cases SET state=$2,next_action='判断客户反馈',stop_reason=NULL,version=$3,updated_at=clock_timestamp() WHERE case_id=$1`, [caseId, previousState, nextVersion]);
      }
      if (action === 'edit' && !payload) { await client.query('ROLLBACK'); return failure('INVALID_INPUT', '修改建议必须提供内容'); }
      const status = proposalActionState(action);
      const updated = await client.query(`UPDATE crm_ai_proposals SET status=$2,payload_json=COALESCE($3,payload_json),acted_by=$4,acted_at=now() WHERE proposal_id=$1 RETURNING *`, [proposalId, status, payload ? JSON.stringify(payload) : null, actor.userId]);
      await client.query(`INSERT INTO crm_case_events(case_id,event_key,event_type,source,payload_json,evidence_json,actor_user_id) VALUES($1,$2,$3,'user',$4,'[]'::jsonb,$5) ON CONFLICT(event_key) DO NOTHING`, [proposal.case_id, `proposal:${proposalId}:${status}`, `proposal.${status}`, JSON.stringify({ proposalId, status }), actor.userId]);
      if(proposal.proposal_type==='deal_won'&&proposal.status==='applied_pending_confirmation'&&action==='cancel'){const previousStatus=(await customerStatusStateIn(client,String(caseRow.customer_id)))?.status??'won_pending';const nextStatus=await derivedCustomerStatusIn(client,String(caseRow.customer_id))??previousStatus;await recordCustomerStatusEventIn(client,{eventKey:`deal-won-cancel:${proposalId}`,customerId:String(caseRow.customer_id),contactId:Number(caseRow.contact_id),status:nextStatus,previousStatus,source:'human',signal:'correction',actorUserId:actor.userId,reason:'取消 AI 成交记录',payload:{caseId,proposalId,previousState:typeof proposal.payload_json?.previousState==='string'?proposal.payload_json.previousState:null},occurredAt:new Date(),recordWhenUnchanged:true});}
      await client.query('COMMIT');
      return success(mapProposal(updated.rows[0]));
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* transaction may already be closed */ }
      this.log.write('ERROR', 'sales-case.pg', `建议处理失败 code=${(error as any)?.code || 'UNKNOWN'}`);
      return failure('DATABASE_ERROR', '建议处理失败');
    } finally { client.release(); }
  }
}
