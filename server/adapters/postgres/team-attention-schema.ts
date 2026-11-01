import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { failure, success, type Result } from '../../core/crm';
import { TEAM_ATTENTION_LIMITS } from '../../core/team-attention';

export const TEAM_ATTENTION_SCHEMA_VERSION = '060-team-attention-task-gating';
export const TEAM_ATTENTION_LOCK = 600060;

export const TEAM_ATTENTION_SQL = `
DO $$
BEGIN
  IF to_regclass('crm_followup_tasks') IS NULL THEN
    RAISE EXCEPTION '060 requires follow-up tasks';
  END IF;
  IF to_regclass('crm_org_assignments') IS NULL THEN
    RAISE EXCEPTION '060 requires canonical organization assignments';
  END IF;
  IF to_regclass('crm_contact_mail_analyses') IS NULL THEN
    RAISE EXCEPTION '060 requires contact mail analyses';
  END IF;
END
$$;

ALTER TABLE crm_followup_tasks
  ADD COLUMN source_kind text CHECK(source_kind IS NULL OR source_kind='mail_analysis'),
  ADD COLUMN source_suggestion_id uuid REFERENCES crm_contact_mail_task_suggestions(suggestion_id),
  ADD COLUMN source_analysis_id uuid REFERENCES crm_contact_mail_analyses(analysis_id),
  ADD COLUMN source_contact_id integer REFERENCES contacts(id),
  ADD COLUMN source_thread_key text,
  ADD COLUMN source_action_code text,
  ADD COLUMN source_responsible_user_id uuid REFERENCES public.identity_users(user_id),
  ADD CONSTRAINT crm_followup_tasks_mail_source_complete CHECK(
    source_kind IS NULL OR (
      source_suggestion_id IS NOT NULL AND source_analysis_id IS NOT NULL
      AND source_contact_id IS NOT NULL AND btrim(source_thread_key)<>''
      AND btrim(source_action_code)<>'' AND source_responsible_user_id IS NOT NULL
    )
  );

CREATE UNIQUE INDEX idx_crm_followup_tasks_mail_suggestion
  ON crm_followup_tasks(source_suggestion_id)
  WHERE source_suggestion_id IS NOT NULL;
CREATE UNIQUE INDEX idx_crm_followup_tasks_open_mail_action
  ON crm_followup_tasks(source_responsible_user_id,source_contact_id,source_thread_key,source_action_code)
  WHERE source_kind='mail_analysis' AND status='open';
CREATE INDEX idx_crm_followup_tasks_mail_source
  ON crm_followup_tasks(source_analysis_id,source_contact_id,created_at DESC);

CREATE TABLE crm_team_attention_items (
  item_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_member_user_id uuid NOT NULL REFERENCES public.identity_users(user_id),
  source_supervisor_user_id uuid NOT NULL REFERENCES public.identity_users(user_id),
  customer_id uuid NOT NULL REFERENCES crm_customers(customer_id),
  contact_id integer NOT NULL REFERENCES contacts(id),
  mail_event_id uuid REFERENCES crm_contact_mail_events(event_id),
  analysis_id uuid REFERENCES crm_contact_mail_analyses(analysis_id),
  reason text NOT NULL CHECK(reason IN ('important_reply','quote_overdue','unhandled_inquiry','bounce_correction')),
  priority text NOT NULL CHECK(priority IN ('normal','important','urgent')),
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','acknowledged','resolved','dismissed')),
  note text CHECK(note IS NULL OR (btrim(note)<>'' AND char_length(note)<=${TEAM_ATTENTION_LIMITS.note})),
  result text CHECK(result IS NULL OR (btrim(result)<>'' AND char_length(result)<=${TEAM_ATTENTION_LIMITS.result})),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  dismissed_at timestamptz,
  CHECK(
    (status='open' AND acknowledged_at IS NULL AND resolved_at IS NULL AND dismissed_at IS NULL AND result IS NULL)
    OR (status='acknowledged' AND acknowledged_at IS NOT NULL AND resolved_at IS NULL AND dismissed_at IS NULL AND result IS NULL)
    OR (status='resolved' AND resolved_at IS NOT NULL AND dismissed_at IS NULL AND result IS NOT NULL)
    OR (status='dismissed' AND dismissed_at IS NOT NULL AND resolved_at IS NULL)
  ),
  FOREIGN KEY(customer_id,contact_id) REFERENCES crm_customer_contacts(customer_id,contact_id)
);
CREATE UNIQUE INDEX idx_crm_team_attention_active_reason
  ON crm_team_attention_items(target_member_user_id,customer_id,contact_id,reason)
  WHERE status IN ('open','acknowledged');
CREATE INDEX idx_crm_team_attention_member
  ON crm_team_attention_items(target_member_user_id,status,priority,updated_at DESC,item_id);
CREATE INDEX idx_crm_team_attention_supervisor
  ON crm_team_attention_items(source_supervisor_user_id,status,updated_at DESC,item_id);
CREATE INDEX idx_crm_team_attention_contact
  ON crm_team_attention_items(customer_id,contact_id,created_at DESC);

CREATE TABLE crm_team_attention_audits (
  audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES crm_team_attention_items(item_id),
  item_version integer NOT NULL CHECK(item_version>0),
  actor_id uuid NOT NULL REFERENCES public.identity_users(user_id),
  action text NOT NULL CHECK(action IN ('created','acknowledged','resolved','dismissed')),
  from_status text CHECK(from_status IS NULL OR from_status IN ('open','acknowledged','resolved','dismissed')),
  to_status text NOT NULL CHECK(to_status IN ('open','acknowledged','resolved','dismissed')),
  note text,
  result text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(item_id,item_version)
);
CREATE INDEX idx_crm_team_attention_audits_item
  ON crm_team_attention_audits(item_id,item_version DESC);

CREATE TABLE crm_team_attention_idempotency (
  actor_id uuid NOT NULL REFERENCES public.identity_users(user_id),
  operation text NOT NULL,
  key text NOT NULL,
  digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(actor_id,operation,key)
);

CREATE TABLE crm_team_attention_notifications (
  item_id uuid NOT NULL REFERENCES crm_team_attention_items(item_id),
  item_version integer NOT NULL CHECK(item_version>0),
  status text NOT NULL CHECK(status IN ('open','acknowledged','resolved','dismissed')),
  event_id uuid NOT NULL UNIQUE REFERENCES public.identity_outbox(event_id),
  recipient_user_ids uuid[] NOT NULL CHECK(cardinality(recipient_user_ids)>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(item_id,item_version)
);
`;

function checksum(): string {
  return createHash('sha256').update(TEAM_ATTENTION_SQL).digest('hex');
}

export async function ensureTeamAttentionSchemaIn(client: PoolClient): Promise<Result<void>> {
  const existing = await client.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1', [TEAM_ATTENTION_SCHEMA_VERSION]);
  if (existing.rows.length) {
    return existing.rows[0].checksum === checksum() ? success(undefined) : failure('CONFLICT', '团队关注迁移校验不一致');
  }
  return migrateTeamAttentionSchema(client);
}

export async function migrateTeamAttentionSchema(client: PoolClient): Promise<Result<void>> {
  const digest = checksum();
  const existing = await client.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1', [TEAM_ATTENTION_SCHEMA_VERSION]);
  if (existing.rows.length) {
    return existing.rows[0].checksum === digest ? success(undefined) : failure('CONFLICT', '团队关注迁移校验不一致');
  }
  await client.query('SELECT pg_advisory_xact_lock($1)', [TEAM_ATTENTION_LOCK]);
  const locked = await client.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1', [TEAM_ATTENTION_SCHEMA_VERSION]);
  if (locked.rows.length) {
    return locked.rows[0].checksum === digest ? success(undefined) : failure('CONFLICT', '团队关注迁移校验不一致');
  }
  await client.query(TEAM_ATTENTION_SQL);
  await client.query('INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)', [TEAM_ATTENTION_SCHEMA_VERSION, digest]);
  return success(undefined);
}
