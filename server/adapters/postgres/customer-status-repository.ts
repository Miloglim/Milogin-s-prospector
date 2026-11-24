import type { Pool, PoolClient } from 'pg';
import { failure, success, type LogSink, type Result } from '../../core/crm';
import {
  customerStatusChange,
  type CustomerStatus,
  type CustomerStatusCorrection,
  type CustomerStatusEvent,
  type CustomerStatusEventInput,
  type CustomerStatusResume,
  type CustomerStatusState,
  type CustomerStatusView,
} from '../../core/customer-status';
import { authorizeLeadActor, canReadLead, type LeadActor } from './lead-repository';

const STATUS_EVENT_COLUMNS = `event_id AS "eventId",event_key AS "eventKey",customer_id AS "customerId",contact_id AS "contactId",status,previous_status AS "previousStatus",source,signal,actor_user_id AS "actorUserId",reason,evidence_json AS evidence,payload_json AS payload,occurred_at AS "occurredAt",recorded_at AS "recordedAt"`;
const STATUS_STATE_COLUMNS = `customer_id AS "customerId",status,previous_status AS "previousStatus",source,signal,contact_id AS "contactId",actor_user_id AS "actorUserId",reason,occurred_at AS "occurredAt",updated_at AS "updatedAt",manual_locked AS "manualLocked",manual_reason AS "manualReason",manual_by AS "manualBy",manual_at AS "manualAt",version`;

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function mapEvent(row: Record<string, unknown>): CustomerStatusEvent {
  return {
    eventId: Number(row.eventId), eventKey: String(row.eventKey), customerId: String(row.customerId),
    contactId: row.contactId === null || row.contactId === undefined ? null : Number(row.contactId),
    status: String(row.status) as CustomerStatus,
    previousStatus: row.previousStatus ? String(row.previousStatus) as CustomerStatus : null,
    source: String(row.source) as CustomerStatusEvent['source'], signal: String(row.signal) as CustomerStatusEvent['signal'],
    actorUserId: row.actorUserId ? String(row.actorUserId) : null, reason: row.reason ? String(row.reason) : null,
    evidence: Array.isArray(row.evidence) ? row.evidence : [],
    payload: row.payload && typeof row.payload === 'object' ? row.payload as Record<string, unknown> : {},
    occurredAt: iso(row.occurredAt), recordedAt: iso(row.recordedAt),
  };
}

function mapState(row: Record<string, unknown>): CustomerStatusState {
  return {
    customerId: String(row.customerId), status: String(row.status) as CustomerStatus,
    previousStatus: row.previousStatus ? String(row.previousStatus) as CustomerStatus : null,
    source: String(row.source) as CustomerStatusState['source'], signal: String(row.signal) as CustomerStatusState['signal'],
    contactId: row.contactId === null || row.contactId === undefined ? null : Number(row.contactId),
    actorUserId: row.actorUserId ? String(row.actorUserId) : null, reason: row.reason ? String(row.reason) : null,
    occurredAt: iso(row.occurredAt), updatedAt: iso(row.updatedAt), manualLocked: row.manualLocked === true,
    manualReason: row.manualReason ? String(row.manualReason) : null, manualBy: row.manualBy ? String(row.manualBy) : null,
    manualAt: row.manualAt ? iso(row.manualAt) : null, version: Number(row.version),
  };
}

export async function customerHasAiDealPendingIn(client: PoolClient, customerId: string): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM crm_ai_proposals proposal
     JOIN crm_sales_cases sales_case ON sales_case.case_id=proposal.case_id
     WHERE sales_case.customer_id=$1 AND proposal.proposal_type='deal_won'
       AND proposal.status='applied_pending_confirmation' LIMIT 1`,
    [customerId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function customerStatusStateIn(client: PoolClient, customerId: string, lock = false): Promise<CustomerStatusState | null> {
  const result = await client.query(`SELECT ${STATUS_STATE_COLUMNS} FROM crm_customer_status_state WHERE customer_id=$1${lock ? ' FOR UPDATE' : ''}`, [customerId]);
  return result.rows[0] ? mapState(result.rows[0]) : null;
}

async function customerStatusEventsIn(client: PoolClient, customerId: string, limit: number): Promise<CustomerStatusEvent[]> {
  const result = await client.query(`SELECT ${STATUS_EVENT_COLUMNS} FROM crm_customer_status_events WHERE customer_id=$1 ORDER BY occurred_at DESC,event_id DESC LIMIT $2`, [customerId, limit]);
  return result.rows.map(mapEvent);
}

async function appendCustomerStatusEventIn(client: PoolClient, input: CustomerStatusEventInput): Promise<CustomerStatusEvent | null> {
  if (input.previousStatus === input.status && !input.recordWhenUnchanged) return null;
  const result = await client.query(
    `INSERT INTO crm_customer_status_events(event_key,customer_id,contact_id,status,previous_status,source,signal,actor_user_id,reason,evidence_json,payload_json,occurred_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12)
     ON CONFLICT(event_key) DO NOTHING
     RETURNING ${STATUS_EVENT_COLUMNS}`,
    [input.eventKey, input.customerId, input.contactId ?? null, input.status, input.previousStatus ?? null, input.source, input.signal,
      input.actorUserId ?? null, input.reason ?? null, JSON.stringify(input.evidence ?? []), JSON.stringify(input.payload ?? {}), input.occurredAt],
  );
  return result.rows[0] ? mapEvent(result.rows[0]) : null;
}

export async function writeCustomerStatusStateIn(client: PoolClient, input: CustomerStatusEventInput, manualLocked: boolean | null, manualReason: string | null = null, manualBy: string | null = null): Promise<void> {
  await client.query(
    `INSERT INTO crm_customer_status_state(customer_id,status,previous_status,source,signal,contact_id,actor_user_id,reason,occurred_at,manual_locked,manual_reason,manual_by,manual_at,version)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CASE WHEN $10 THEN clock_timestamp() ELSE NULL END,1)
     ON CONFLICT(customer_id) DO UPDATE SET status=EXCLUDED.status,previous_status=EXCLUDED.previous_status,source=EXCLUDED.source,signal=EXCLUDED.signal,
       contact_id=EXCLUDED.contact_id,actor_user_id=EXCLUDED.actor_user_id,reason=EXCLUDED.reason,occurred_at=EXCLUDED.occurred_at,updated_at=clock_timestamp(),
       manual_locked=CASE WHEN $13::boolean IS NULL THEN crm_customer_status_state.manual_locked ELSE $13 END,
       manual_reason=CASE WHEN $13::boolean IS NULL THEN crm_customer_status_state.manual_reason ELSE $14 END,
       manual_by=CASE WHEN $13::boolean IS NULL THEN crm_customer_status_state.manual_by ELSE $15 END,
       manual_at=CASE WHEN $13::boolean IS NULL THEN crm_customer_status_state.manual_at WHEN $13 THEN clock_timestamp() ELSE NULL END,
       version=crm_customer_status_state.version+1`,
    [input.customerId, input.status, input.previousStatus ?? null, input.source, input.signal, input.contactId ?? null, input.actorUserId ?? null,
      input.reason ?? null, input.occurredAt, manualLocked === true, manualReason, manualBy, manualLocked, manualReason, manualBy],
  );
}

/** Append once inside the caller's transaction; automatic sources cannot override a manual lock. */
export async function recordCustomerStatusEventIn(client: PoolClient, input: CustomerStatusEventInput): Promise<CustomerStatusEvent | null> {
  const state = await customerStatusStateIn(client, input.customerId, true);
  if (state?.manualLocked && input.source !== 'human') return null;
  const event = await appendCustomerStatusEventIn(client, input);
  if (event) await writeCustomerStatusStateIn(client, input, null);
  return event;
}

export async function derivedCustomerStatusIn(client: PoolClient, customerId: string): Promise<CustomerStatus | null> {
  const result = await client.query(
    `SELECT customer.relationship_stage AS "relationshipStage",
       (SELECT contact.crm_touch_status FROM crm_customer_contacts link JOIN contacts contact ON contact.id=link.contact_id
        WHERE link.customer_id=customer.customer_id AND contact.crm_deleted_at IS NULL ORDER BY contact.id LIMIT 1) AS "touchStatus"
     FROM crm_customers customer WHERE customer.customer_id=$1`,
    [customerId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return customerStatusChange({ relationshipStage: row.relationshipStage, touchStatuses: [row.touchStatus], aiDealPending: await customerHasAiDealPendingIn(client, customerId) }).before;
}

function administrator(a: LeadActor): boolean {
  return a.roles.includes('admin') && ['shared', 'summary'].includes(a.scope) && a.capabilities.includes('leads.read.all');
}

function operational(a: LeadActor): boolean {
  return a.roles.includes('operations') && ['shared', 'summary'].includes(a.scope) && a.capabilities.includes('followups.read');
}

interface CustomerScope { customer_id: string; origin: string; owner_user_id: string | null; created_by: string }

function canCorrect(a: LeadActor, customer: CustomerScope): boolean {
  return a.capabilities.includes('leads.develop') && (administrator(a) || operational(a) && customer.origin === 'operations' || customer.owner_user_id === a.userId);
}

export class PostgresCustomerStatusRepository {
  constructor(private readonly pool: Pool, private readonly log: LogSink) {}

  private async run<T>(hash: string, action: (client: PoolClient, actor: LeadActor) => Promise<Result<T>>): Promise<Result<T>> {
    const client = await this.pool.connect();
    try {
      const actor = await authorizeLeadActor(client, hash);
      if (!actor) return failure('UNAUTHORIZED', 'CRM 会话已失效');
      await client.query('BEGIN');
      const result = await action(client, actor);
      await client.query(result.ok ? 'COMMIT' : 'ROLLBACK');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* transaction may already be closed */ }
      this.log.write('ERROR', 'customer-status.pg', `状态命令失败 ${error instanceof Error ? error.message : 'UNKNOWN'}`);
      return failure('DATABASE_ERROR', '客户状态服务暂不可用');
    } finally { client.release(); }
  }

  view(hash: string, customerId: string): Promise<Result<CustomerStatusView>> {
    return this.run(hash, async (client, actor) => {
      const customer = (await client.query('SELECT customer_id,created_by,owner_user_id,origin FROM crm_customers WHERE customer_id=$1', [customerId])).rows[0] as CustomerScope | undefined;
      if (!customer || !canReadLead(actor, { ...customer, state: 'owned' })) return failure('NOT_FOUND', '客户不存在');
      return success({ state: await customerStatusStateIn(client, customerId), events: await customerStatusEventsIn(client, customerId, 50) });
    });
  }

  correct(hash: string, input: CustomerStatusCorrection): Promise<Result<CustomerStatusState>> {
    return this.run(hash, async (client, actor) => {
      const customer = (await client.query('SELECT customer_id,created_by,owner_user_id,origin FROM crm_customers WHERE customer_id=$1 FOR UPDATE', [input.customerId])).rows[0] as CustomerScope | undefined;
      if (!customer || !canCorrect(actor, customer)) return failure('FORBIDDEN', '没有纠正客户状态权限');
      const state = await customerStatusStateIn(client, input.customerId, true);
      if ((state?.version ?? 0) !== input.expectedVersion) return failure('CONFLICT', '客户状态已变化，请刷新后重试');
      const previous = state?.status ?? await derivedCustomerStatusIn(client, input.customerId) ?? 'uncontacted';
      const event: CustomerStatusEventInput = {
        eventKey: `correction:${input.customerId}:${input.idempotencyKey}`, customerId: input.customerId, contactId: input.contactId ?? state?.contactId ?? null,
        status: input.status, previousStatus: previous, source: 'human', signal: 'correction', actorUserId: actor.userId, reason: input.reason,
        payload: { manualLocked: true }, occurredAt: new Date(), recordWhenUnchanged: true,
      };
      const appended = await appendCustomerStatusEventIn(client, event);
      if (!appended) { const existing = await customerStatusStateIn(client, input.customerId); return existing ? success(existing) : failure('CONFLICT', '状态纠正请求已处理'); }
      await writeCustomerStatusStateIn(client, event, true, input.reason, actor.userId);
      const saved = await customerStatusStateIn(client, input.customerId);
      return saved ? success(saved) : failure('DATABASE_ERROR', '状态纠正未保存');
    });
  }

  resumeAi(hash: string, input: CustomerStatusResume): Promise<Result<CustomerStatusState>> {
    return this.run(hash, async (client, actor) => {
      const customer = (await client.query('SELECT customer_id,created_by,owner_user_id,origin FROM crm_customers WHERE customer_id=$1 FOR UPDATE', [input.customerId])).rows[0] as CustomerScope | undefined;
      if (!customer || !canCorrect(actor, customer)) return failure('FORBIDDEN', '没有恢复客户状态权限');
      const state = await customerStatusStateIn(client, input.customerId, true);
      if (!state) return failure('NOT_FOUND', '客户状态尚未建立');
      if (state.version !== input.expectedVersion) return failure('CONFLICT', '客户状态已变化，请刷新后重试');
      if (!state.manualLocked) return success(state);
      const event: CustomerStatusEventInput = {
        eventKey: `ai-resume:${input.customerId}:${input.idempotencyKey}`, customerId: input.customerId, contactId: state.contactId,
        status: state.status, previousStatus: state.status, source: 'human', signal: 'ai_resume', actorUserId: actor.userId, reason: '恢复 AI 自动维护',
        payload: {}, occurredAt: new Date(), recordWhenUnchanged: true,
      };
      const appended = await appendCustomerStatusEventIn(client, event);
      if (!appended) { const existing = await customerStatusStateIn(client, input.customerId); return existing ? success(existing) : failure('CONFLICT', '恢复请求已处理'); }
      await writeCustomerStatusStateIn(client, event, false);
      const saved = await customerStatusStateIn(client, input.customerId);
      return saved ? success(saved) : failure('DATABASE_ERROR', '恢复 AI 维护未保存');
    });
  }
}
