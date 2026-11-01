import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { failure, success, type Result } from '../../core/crm';

export const TEAM_MONITORING_SCHEMA_VERSION = '061-team-monitoring';
export const TEAM_MONITORING_LOCK = 610061;

export const TEAM_MONITORING_SQL = `
DO $$
BEGIN
  IF to_regclass('crm_org_units') IS NULL OR to_regclass('crm_org_assignments') IS NULL THEN
    RAISE EXCEPTION '061 requires canonical organization tables';
  END IF;
  IF to_regclass('crm_contact_ownership') IS NULL OR to_regclass('crm_team_attention_items') IS NULL THEN
    RAISE EXCEPTION '061 requires assignment and attention tables';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM crm_schema_migrations WHERE version='060-team-attention-task-gating') THEN
    RAISE EXCEPTION '061 requires 060-team-attention-task-gating';
  END IF;
END
$$;

CREATE TABLE crm_team_monitoring_audits (
  audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL REFERENCES public.identity_users(user_id),
  scope text NOT NULL CHECK(scope IN ('leader','operations','superadmin')),
  target_kind text NOT NULL CHECK(target_kind IN ('contact','mail')),
  target_id text NOT NULL CHECK(btrim(target_id)<>''),
  contact_id integer NOT NULL REFERENCES contacts(id),
  customer_id uuid NOT NULL REFERENCES crm_customers(customer_id),
  mail_event_id uuid REFERENCES crm_contact_mail_events(event_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((target_kind='contact' AND mail_event_id IS NULL) OR (target_kind='mail' AND mail_event_id IS NOT NULL)),
  FOREIGN KEY(customer_id,contact_id) REFERENCES crm_customer_contacts(customer_id,contact_id)
);
CREATE INDEX idx_crm_team_monitoring_audits_actor
  ON crm_team_monitoring_audits(actor_id,created_at DESC,audit_id DESC);
CREATE INDEX idx_crm_team_monitoring_audits_contact
  ON crm_team_monitoring_audits(contact_id,created_at DESC,audit_id DESC);

CREATE OR REPLACE FUNCTION crm_reject_team_monitoring_audit_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'team monitoring audits are append-only';
END
$$;
CREATE TRIGGER trg_crm_team_monitoring_audits_immutable
BEFORE UPDATE OR DELETE ON crm_team_monitoring_audits
FOR EACH ROW EXECUTE FUNCTION crm_reject_team_monitoring_audit_change();

CREATE INDEX idx_crm_team_monitoring_mail_actor
  ON crm_contact_mail_events(actor_id,occurred_at DESC,event_id);
CREATE INDEX idx_crm_team_monitoring_analysis_actor
  ON crm_contact_mail_analyses(actor_id,classification,priority,created_at DESC)
  WHERE is_current;
CREATE INDEX idx_crm_team_monitoring_tasks_responsible
  ON crm_followup_tasks(source_responsible_user_id,due_at,task_id)
  WHERE status='open' AND source_responsible_user_id IS NOT NULL;
`;

function checksum(): string {
  return createHash('sha256').update(TEAM_MONITORING_SQL).digest('hex');
}

export async function migrateTeamMonitoringSchema(client: PoolClient): Promise<Result<void>> {
  const digest = checksum();
  const existing = await client.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1', [TEAM_MONITORING_SCHEMA_VERSION]);
  if (existing.rows.length) {
    return existing.rows[0].checksum === digest ? success(undefined) : failure('CONFLICT', '团队监控迁移校验不一致');
  }
  await client.query('SELECT pg_advisory_xact_lock($1)', [TEAM_MONITORING_LOCK]);
  const locked = await client.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1', [TEAM_MONITORING_SCHEMA_VERSION]);
  if (locked.rows.length) {
    return locked.rows[0].checksum === digest ? success(undefined) : failure('CONFLICT', '团队监控迁移校验不一致');
  }
  await client.query(TEAM_MONITORING_SQL);
  await client.query('INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)', [TEAM_MONITORING_SCHEMA_VERSION, digest]);
  return success(undefined);
}
