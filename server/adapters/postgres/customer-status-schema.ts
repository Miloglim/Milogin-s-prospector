import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { failure, success, type Result } from '../../core/crm';

export const CUSTOMER_STATUS_SCHEMA_VERSION = '083-customer-status-events';
export const CUSTOMER_STATUS_SCHEMA_LOCK = 830083;
export const CUSTOMER_STATUS_STATE_SCHEMA_VERSION = '084-customer-status-command';
export const CUSTOMER_STATUS_STATE_SCHEMA_LOCK = 840084;

export const CUSTOMER_STATUS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS crm_customer_status_events (
  event_id bigserial PRIMARY KEY,
  event_key text NOT NULL UNIQUE,
  customer_id uuid NOT NULL REFERENCES crm_customers(customer_id) ON DELETE CASCADE,
  contact_id bigint REFERENCES contacts(id) ON DELETE SET NULL,
  status text NOT NULL CHECK(status IN ('uncontacted','contacted','replied','quoting','negotiating','won_pending','won','lost')),
  previous_status text CHECK(previous_status IS NULL OR previous_status IN ('uncontacted','contacted','replied','quoting','negotiating','won_pending','won','lost')),
  source text NOT NULL CHECK(source IN ('ai','human','system','import')),
  signal text NOT NULL CHECK(signal IN ('followup','mail','deal_won','correction','import')),
  actor_user_id uuid REFERENCES public.identity_users(user_id),
  reason text,
  evidence_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_customer_status_events_customer ON crm_customer_status_events(customer_id,occurred_at DESC,event_id DESC);
CREATE INDEX IF NOT EXISTS idx_customer_status_events_contact ON crm_customer_status_events(contact_id,occurred_at DESC,event_id DESC);
`;

export async function migrateCustomerStatusSchemaIn(client: PoolClient): Promise<Result<void>> {
  await client.query('SELECT pg_advisory_xact_lock($1)', [CUSTOMER_STATUS_SCHEMA_LOCK]);
  const checksum = createHash('sha256').update(CUSTOMER_STATUS_SCHEMA_SQL).digest('hex');
  const old = await client.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1', [CUSTOMER_STATUS_SCHEMA_VERSION]);
  if (old.rows.length && old.rows[0].checksum !== checksum) return failure('CONFLICT', '客户状态事件迁移校验不一致');
  if (!old.rows.length) {
    await client.query(CUSTOMER_STATUS_SCHEMA_SQL);
    await client.query('INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)', [CUSTOMER_STATUS_SCHEMA_VERSION, checksum]);
  }
  return migrateCustomerStatusStateSchemaIn(client);
}

export const CUSTOMER_STATUS_STATE_SCHEMA_SQL = `
ALTER TABLE crm_customer_status_events DROP CONSTRAINT IF EXISTS crm_customer_status_events_signal_check;
ALTER TABLE crm_customer_status_events ADD CONSTRAINT crm_customer_status_events_signal_check
  CHECK(signal IN ('followup','mail','deal_won','opportunity','sales_case','correction','ai_resume','import'));
CREATE TABLE IF NOT EXISTS crm_customer_status_state (
  customer_id uuid PRIMARY KEY REFERENCES crm_customers(customer_id) ON DELETE CASCADE,
  status text NOT NULL CHECK(status IN ('uncontacted','contacted','replied','quoting','negotiating','won_pending','won','lost')),
  previous_status text CHECK(previous_status IS NULL OR previous_status IN ('uncontacted','contacted','replied','quoting','negotiating','won_pending','won','lost')),
  source text NOT NULL CHECK(source IN ('ai','human','system','import')),
  signal text NOT NULL CHECK(signal IN ('followup','mail','deal_won','opportunity','sales_case','correction','ai_resume','import')),
  contact_id bigint REFERENCES contacts(id) ON DELETE SET NULL,
  actor_user_id uuid REFERENCES public.identity_users(user_id),
  reason text,
  occurred_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  manual_locked boolean NOT NULL DEFAULT false,
  manual_reason text,
  manual_by uuid REFERENCES public.identity_users(user_id),
  manual_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK(version > 0),
  CHECK(NOT manual_locked OR manual_reason IS NOT NULL AND manual_by IS NOT NULL AND manual_at IS NOT NULL)
);
`;

export async function migrateCustomerStatusStateSchemaIn(client: PoolClient): Promise<Result<void>> {
  await client.query('SELECT pg_advisory_xact_lock($1)', [CUSTOMER_STATUS_STATE_SCHEMA_LOCK]);
  const checksum = createHash('sha256').update(CUSTOMER_STATUS_STATE_SCHEMA_SQL).digest('hex');
  const old = await client.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1', [CUSTOMER_STATUS_STATE_SCHEMA_VERSION]);
  if (old.rows.length && old.rows[0].checksum !== checksum) return failure('CONFLICT', '客户状态命令迁移校验不一致');
  if (!old.rows.length) {
    await client.query(CUSTOMER_STATUS_STATE_SCHEMA_SQL);
    await client.query('INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)', [CUSTOMER_STATUS_STATE_SCHEMA_VERSION, checksum]);
  }
  return success(undefined);
}
