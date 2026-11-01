import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { failure, success, type Result } from '../../core/crm';

export const SALES_PERFORMANCE_SCHEMA_VERSION = '062-sales-performance-customer-grade';
export const SALES_PERFORMANCE_SCHEMA_LOCK = 620062;

export const SALES_PERFORMANCE_SQL = `
DO $$
BEGIN
  IF to_regclass('crm_contact_ownership') IS NULL
     OR to_regclass('crm_contact_mail_analyses') IS NULL
     OR to_regclass('crm_opportunity_stage_history') IS NULL
     OR to_regclass('crm_followup_tasks') IS NULL THEN
    RAISE EXCEPTION '062 requires ownership, mail analysis, opportunity and task facts';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM crm_schema_migrations WHERE version='061-team-monitoring') THEN
    RAISE EXCEPTION '062 requires 061-team-monitoring';
  END IF;
END
$$;

CREATE TABLE crm_customer_grade_overrides (
  customer_id uuid PRIMARY KEY REFERENCES crm_customers(customer_id),
  grade text NOT NULL CHECK(grade IN ('A','B','C')),
  reason text NOT NULL CHECK(btrim(reason)<>'' AND char_length(reason)<=1000),
  actor_id uuid NOT NULL REFERENCES public.identity_users(user_id),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX idx_crm_customer_grade_overrides_actor
  ON crm_customer_grade_overrides(actor_id,updated_at DESC,customer_id);

CREATE TABLE crm_customer_grade_override_audits (
  audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES crm_customers(customer_id),
  action text NOT NULL CHECK(action IN ('set','clear')),
  from_grade text CHECK(from_grade IS NULL OR from_grade IN ('A','B','C')),
  to_grade text CHECK(to_grade IS NULL OR to_grade IN ('A','B','C')),
  reason text NOT NULL CHECK(btrim(reason)<>'' AND char_length(reason)<=1000),
  actor_id uuid NOT NULL REFERENCES public.identity_users(user_id),
  override_version integer NOT NULL CHECK(override_version>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((action='set' AND to_grade IS NOT NULL) OR (action='clear' AND to_grade IS NULL))
);
CREATE INDEX idx_crm_customer_grade_override_audits_customer
  ON crm_customer_grade_override_audits(customer_id,created_at DESC,audit_id DESC);
CREATE INDEX idx_crm_customer_grade_override_audits_actor
  ON crm_customer_grade_override_audits(actor_id,created_at DESC,audit_id DESC);

CREATE OR REPLACE FUNCTION crm_reject_customer_grade_audit_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'customer grade audit is append only';
END
$$;
CREATE TRIGGER trg_crm_customer_grade_audit_immutable
BEFORE UPDATE OR DELETE ON crm_customer_grade_override_audits
FOR EACH ROW EXECUTE FUNCTION crm_reject_customer_grade_audit_change();

CREATE TABLE crm_customer_grade_override_idempotency (
  actor_id uuid NOT NULL REFERENCES public.identity_users(user_id),
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(actor_id,operation,idempotency_key)
);

-- Query-time metric indexes only; no score, grade snapshot or conclusion is stored.
CREATE INDEX idx_crm_sales_perf_ownership_start
  ON crm_contact_ownership(owner_user_id,started_at,ended_at,customer_id,contact_id);
CREATE INDEX idx_crm_sales_perf_activity_actor
  ON crm_shared_activities(actor_id,occurred_at,customer_id,contact_id)
  WHERE contact_id IS NOT NULL;
CREATE INDEX idx_crm_sales_perf_tasks_completed
  ON crm_followup_tasks(customer_id,completed_at,completed_by)
  WHERE status='completed';
CREATE INDEX idx_crm_sales_perf_mail_current_reply
  ON crm_contact_mail_analyses(event_id,contact_id,customer_id)
  WHERE is_current AND classification='replied' AND relevance='customer_business';
CREATE INDEX idx_crm_sales_perf_won_history
  ON crm_opportunity_stage_history(occurred_at,opportunity_id)
  WHERE to_stage='closed_won';
CREATE INDEX idx_crm_sales_perf_import_customer
  ON crm_import_rows(customer_id,batch_id)
  WHERE customer_id IS NOT NULL;
CREATE INDEX idx_crm_sales_perf_customer_origin_source
  ON crm_customers(origin,source,customer_id);
`;

function checksum(): string {
  return createHash('sha256').update(SALES_PERFORMANCE_SQL).digest('hex');
}

export async function migrateSalesPerformanceSchema(client: PoolClient): Promise<Result<void>> {
  const digest = checksum();
  const existing = await client.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1', [SALES_PERFORMANCE_SCHEMA_VERSION]);
  if (existing.rows.length) {
    return existing.rows[0].checksum === digest ? success(undefined) : failure('CONFLICT', '销售绩效迁移校验不一致');
  }
  await client.query('SELECT pg_advisory_xact_lock($1)', [SALES_PERFORMANCE_SCHEMA_LOCK]);
  const locked = await client.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1', [SALES_PERFORMANCE_SCHEMA_VERSION]);
  if (locked.rows.length) {
    return locked.rows[0].checksum === digest ? success(undefined) : failure('CONFLICT', '销售绩效迁移校验不一致');
  }
  await client.query(SALES_PERFORMANCE_SQL);
  await client.query('INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)', [SALES_PERFORMANCE_SCHEMA_VERSION, digest]);
  return success(undefined);
}
