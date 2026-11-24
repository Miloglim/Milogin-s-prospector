import type { Pool, PoolClient } from 'pg';
import { failure, success, type Result } from '../../core/crm';
import {
  highestCustomerStatus,
  opportunityCustomerStatus,
  salesCaseCustomerStatus,
  type CustomerStatus,
} from '../../core/customer-status';
import { planCustomerStatusBackfill, type CustomerStatusBackfillSignal } from '../../core/customer-state-backfill';
import { customerStatusStateIn, derivedCustomerStatusIn, writeCustomerStatusStateIn } from './customer-status-repository';
import { effectiveMailFactSql } from './contact-mail-projection-sql';

export interface CustomerStatusBackfillReport {
  customerId: string;
  companyName: string;
  manualLocked: boolean;
  currentStatus: CustomerStatus;
  plannedEvents: number;
  skippedSignals: number;
  finalStatus: CustomerStatus;
  existingEvents: number;
}

export interface CustomerStatusBackfillSummary {
  apply: boolean;
  customers: number;
  lockedCustomers: number;
  plannedEvents: number;
  insertedEvents: number;
  reports: CustomerStatusBackfillReport[];
}

const ACTIVITY_STAGE_STATUS: Record<string, CustomerStatus> = {
  reaching: 'contacted', quoting: 'quoting', trial: 'negotiating', cooperating: 'won', lost: 'lost',
};
const TOUCH_STATUS: Record<string, CustomerStatus> = {
  contacted: 'contacted', replied: 'replied', autoreply: 'contacted',
};

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

async function activitySignals(client: PoolClient, customerId: string): Promise<CustomerStatusBackfillSignal[]> {
  const rows = (await client.query(
    `SELECT id::text,occurred_at AS "occurredAt",stage,contact_status AS "contactStatus",method,note
     FROM crm_shared_activities WHERE customer_id=$1 ORDER BY occurred_at,id`,
    [customerId],
  )).rows;
  const signals: CustomerStatusBackfillSignal[] = [];
  for (const row of rows) {
    const proposed = highestCustomerStatus([ACTIVITY_STAGE_STATUS[String(row.stage ?? '')], TOUCH_STATUS[String(row.contactStatus ?? '')]]);
    if (!proposed) continue;
    signals.push({ key: `activity:${row.id}`, occurredAt: iso(row.occurredAt), proposedStatus: proposed, source: 'activity', sourceId: String(row.id), evidence: [{ type: 'activity', id: String(row.id), note: row.note }], payload: { stage: row.stage, contactStatus: row.contactStatus, method: row.method } });
  }
  return signals;
}

async function mailSignals(client: PoolClient, customerId: string): Promise<CustomerStatusBackfillSignal[]> {
  const rows = (await client.query(
    `SELECT mf.event_id::text, mf.occurred_at AS "occurredAt", mf.kind, mf.direction, mf.activity_id::text AS "activityId", mf.subject
     FROM crm_contact_mail_events mf WHERE mf.customer_id=$1 AND ${effectiveMailFactSql('mf')} ORDER BY mf.occurred_at,mf.event_id`,
    [customerId],
  )).rows;
  const signals: CustomerStatusBackfillSignal[] = [];
  for (const row of rows) {
    const proposed = row.kind === 'replied' && row.direction === 'inbound' ? 'replied'
      : row.kind === 'sent' && row.direction === 'outbound' ? 'contacted'
      : row.kind === 'autoreply' ? 'contacted' : null;
    if (!proposed) continue;
    signals.push({ key: `mail:${row.event_id}`, occurredAt: iso(row.occurredAt), proposedStatus: proposed, source: 'mail', sourceId: String(row.event_id), evidence: [{ type: 'mail', id: String(row.event_id), subject: row.subject }], payload: { kind: row.kind, direction: row.direction, activityId: row.activityId } });
  }
  return signals;
}

async function opportunitySignals(client: PoolClient, customerId: string): Promise<CustomerStatusBackfillSignal[]> {
  const rows = (await client.query(
    `SELECT history.history_id::text,history.occurred_at AS "occurredAt",history.from_stage AS "fromStage",history.to_stage AS "toStage",opportunity.opportunity_id::text AS "opportunityId"
     FROM crm_opportunity_stage_history history JOIN crm_opportunities opportunity USING(opportunity_id)
     WHERE opportunity.customer_id=$1 ORDER BY history.occurred_at,history.history_id`,
    [customerId],
  )).rows;
  const signals: CustomerStatusBackfillSignal[] = [];
  for (const row of rows) {
    const proposed = opportunityCustomerStatus(String(row.toStage));
    if (!proposed) continue;
    signals.push({ key: `opportunity:${row.history_id}`, occurredAt: iso(row.occurredAt), proposedStatus: proposed, source: 'opportunity', sourceId: String(row.history_id), evidence: [{ type: 'opportunity', id: row.opportunityId }], payload: { opportunityId: row.opportunityId, fromStage: row.fromStage, toStage: row.toStage } });
  }
  return signals;
}

async function caseSignals(client: PoolClient, customerId: string): Promise<CustomerStatusBackfillSignal[]> {
  const rows = (await client.query(
    `SELECT event.event_id,event.created_at AS "occurredAt",event.event_type AS "eventType",event.source,event.payload_json AS payload,sales_case.case_id::text AS "caseId"
     FROM crm_case_events event JOIN crm_sales_cases sales_case USING(case_id)
     WHERE sales_case.customer_id=$1 ORDER BY event.created_at,event.event_id`,
    [customerId],
  )).rows;
  const signals: CustomerStatusBackfillSignal[] = [];
  for (const row of rows) {
    const eventType = String(row.eventType);
    if (eventType === 'proposal.cancelled' || eventType === 'case.won' && row.source === 'ai') continue;
    const proposed = eventType === 'reply.received' ? 'replied'
      : eventType === 'inquiry.detected' || eventType === 'quote.requested' || eventType === 'quote.confirmed' ? 'quoting'
      : eventType === 'case.won' ? 'won'
      : eventType === 'case.lost' ? 'lost' : null;
    if (!proposed) continue;
    signals.push({ key: `case:${row.event_id}`, occurredAt: iso(row.occurredAt), proposedStatus: proposed, source: 'case', sourceId: String(row.event_id), evidence: [{ type: 'case', id: row.caseId, eventType }], payload: { caseId: row.caseId, eventType, source: row.source, original: row.payload } });
  }
  return signals;
}

async function aiSignals(client: PoolClient, customerId: string): Promise<CustomerStatusBackfillSignal[]> {
  const rows = (await client.query(
    `SELECT proposal.proposal_id::text,proposal.created_at AS "createdAt",proposal.acted_at AS "actedAt",proposal.status,proposal.payload_json AS payload,sales_case.case_id::text AS "caseId"
     FROM crm_ai_proposals proposal JOIN crm_sales_cases sales_case USING(case_id)
     WHERE sales_case.customer_id=$1 AND proposal.proposal_type='deal_won' ORDER BY proposal.created_at,proposal.proposal_id`,
    [customerId],
  )).rows;
  const signals: CustomerStatusBackfillSignal[] = [];
  for (const row of rows) {
    signals.push({ key: `ai-won:${row.proposal_id}`, occurredAt: iso(row.createdAt), proposedStatus: 'won_pending', source: 'ai', sourceId: String(row.proposal_id), evidence: [{ type: 'ai_proposal', id: row.proposal_id }], payload: { caseId: row.caseId, status: row.status } });
    if (row.status === 'cancelled' && row.actedAt) {
      const restored = salesCaseCustomerStatus(String(row.payload?.previousState ?? 'replied'));
      if (restored) signals.push({ key: `ai-cancel:${row.proposal_id}`, occurredAt: iso(row.actedAt), proposedStatus: restored, source: 'ai', sourceId: String(row.proposal_id), evidence: [{ type: 'ai_proposal', id: row.proposal_id, status: 'cancelled' }], payload: { caseId: row.caseId, previousState: row.payload?.previousState ?? null }, allowRegression: true });
    }
  }
  return signals;
}

async function loadSignals(client: PoolClient, customerId: string): Promise<CustomerStatusBackfillSignal[]> {
  const signals: CustomerStatusBackfillSignal[] = [];
  signals.push(...await activitySignals(client, customerId));
  signals.push(...await mailSignals(client, customerId));
  signals.push(...await opportunitySignals(client, customerId));
  signals.push(...await caseSignals(client, customerId));
  signals.push(...await aiSignals(client, customerId));
  return signals;
}

async function backfillOne(client: PoolClient, customer: { customerId: string; companyName: string }, apply: boolean): Promise<{ report: CustomerStatusBackfillReport; inserted: number }> {
  const state = await customerStatusStateIn(client, customer.customerId, true);
  const currentStatus = state?.status ?? await derivedCustomerStatusIn(client, customer.customerId) ?? 'uncontacted';
  const signals = await loadSignals(client, customer.customerId);
  if (!state?.manualLocked) {
    signals.push({ key: 'current', occurredAt: new Date().toISOString(), proposedStatus: currentStatus, source: 'activity', sourceId: 'current', evidence: [{ type: 'current_state' }], payload: { reason: '回填当前状态' }, allowRegression: true });
  }
  const plan = planCustomerStatusBackfill(signals);
  const existingEvents = Number((await client.query('SELECT count(*)::int AS n FROM crm_customer_status_events WHERE customer_id=$1', [customer.customerId])).rows[0].n);
  let inserted = 0;
  if (apply) {
    for (const event of plan.events) {
      const result = await client.query(
        `INSERT INTO crm_customer_status_events(event_key,customer_id,contact_id,status,previous_status,source,signal,actor_user_id,reason,evidence_json,payload_json,occurred_at)
         VALUES($1,$2,NULL,$3,$4,'import','import',NULL,$5,$6::jsonb,$7::jsonb,$8) ON CONFLICT(event_key) DO NOTHING`,
        [`backfill:${customer.customerId}:${event.key}`, customer.customerId, event.status, event.previousStatus, `历史回填：${event.source}`, JSON.stringify(event.evidence), JSON.stringify({ ...event.payload, sourceId: event.sourceId }), event.occurredAt],
      );
      inserted += result.rowCount ?? 0;
    }
    if (!state?.manualLocked && (!state || inserted > 0)) {
      const last = plan.events.at(-1);
      await writeCustomerStatusStateIn(client, {
        eventKey: `backfill-state:${customer.customerId}`, customerId: customer.customerId, status: plan.finalStatus,
        previousStatus: last?.previousStatus ?? null, source: 'import', signal: 'import', reason: '历史回填当前状态',
        evidence: last?.evidence ?? [], payload: last?.payload ?? {}, occurredAt: last?.occurredAt ?? new Date(),
      }, null);
    }
  }
  return {
    inserted,
    report: {
      customerId: customer.customerId, companyName: customer.companyName, manualLocked: state?.manualLocked === true,
      currentStatus, plannedEvents: plan.events.length, skippedSignals: plan.skipped,
      finalStatus: state?.manualLocked ? currentStatus : plan.finalStatus, existingEvents,
    },
  };
}

export async function backfillCustomerStatuses(pool: Pool, options: { apply: boolean; customerIds?: string[] }): Promise<Result<CustomerStatusBackfillSummary>> {
  const client = await pool.connect();
  try {
    if (options.apply) await client.query('BEGIN');
    const customers = (await client.query(
      `SELECT customer.customer_id AS "customerId",company.name AS "companyName"
       FROM crm_customers customer JOIN companies company ON company.id=customer.company_id
       WHERE $1::uuid[] IS NULL OR customer.customer_id=ANY($1::uuid[]) ORDER BY customer.customer_id`,
      [options.customerIds?.length ? options.customerIds : null],
    )).rows as Array<{ customerId: string; companyName: string }>;
    const reports: CustomerStatusBackfillReport[] = [];
    let insertedEvents = 0;
    for (const customer of customers) {
      const result = await backfillOne(client, customer, options.apply);
      insertedEvents += result.inserted;
      reports.push(result.report);
    }
    if (options.apply) await client.query('COMMIT');
    return success({
      apply: options.apply, customers: reports.length, lockedCustomers: reports.filter(report => report.manualLocked).length,
      plannedEvents: reports.reduce((sum, report) => sum + report.plannedEvents, 0), insertedEvents, reports,
    });
  } catch (error) {
    if (options.apply) try { await client.query('ROLLBACK'); } catch { /* transaction may already be closed */ }
    return failure('DATABASE_ERROR', `历史状态回填失败：${error instanceof Error ? error.message : 'UNKNOWN'}`);
  } finally { client.release(); }
}
