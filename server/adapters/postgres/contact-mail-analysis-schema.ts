import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { failure, success, type Result } from '../../core/crm';

export const CONTACT_MAIL_ANALYSIS_SCHEMA_VERSION = '059-contact-mail-analysis';
export const CONTACT_MAIL_ANALYSIS_LOCK = 590059;

export const CONTACT_MAIL_ANALYSIS_SQL = `
DO $$
BEGIN
  IF to_regclass('crm_contact_mail_events') IS NULL THEN
    RAISE EXCEPTION '059 requires contact mail events';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM crm_schema_migrations WHERE version='057-contact-assignment-state') THEN
    RAISE EXCEPTION '059 requires contact ownership';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM crm_schema_migrations WHERE version='058-lead-ingress-conflict') THEN
    RAISE EXCEPTION '059 requires lead conflict decisions';
  END IF;
END
$$;

CREATE TABLE crm_contact_mail_analyses (
  analysis_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL REFERENCES public.identity_users(user_id),
  event_id uuid REFERENCES crm_contact_mail_events(event_id),
  contact_id integer NOT NULL REFERENCES contacts(id),
  customer_id uuid NOT NULL REFERENCES crm_customers(customer_id),
  mailbox_key text NOT NULL,
  message_key text NOT NULL,
  content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
  thread_key text NOT NULL,
  analyzer_version text NOT NULL,
  input_sequence bigint NOT NULL,
  source text NOT NULL CHECK(source IN ('rule','ai','human')),
  relevance text NOT NULL CHECK(relevance IN ('customer_business','internal','notification','vendor','spam','unknown')),
  classification text NOT NULL CHECK(classification IN ('other','replied','autoreply','bounced')),
  contact_state text CHECK(contact_state IN ('contacted','replied','bounced','autoreply')),
  summary text NOT NULL,
  signals jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(signals)='array'),
  requires_action boolean NOT NULL,
  next_action text,
  priority text NOT NULL CHECK(priority IN ('normal','important','urgent')),
  due_hint text,
  confidence numeric(4,3) NOT NULL CHECK(confidence>=0 AND confidence<=1),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(evidence)='array'),
  human_locked boolean NOT NULL DEFAULT false CHECK(human_locked=(source='human')),
  idempotency_key text NOT NULL,
  request_digest text NOT NULL,
  supersedes_id uuid REFERENCES crm_contact_mail_analyses(analysis_id),
  is_current boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(actor_id,mailbox_key,message_key,contact_id,content_hash,idempotency_key),
  FOREIGN KEY(customer_id,contact_id) REFERENCES crm_customer_contacts(customer_id,contact_id)
);

CREATE UNIQUE INDEX idx_crm_contact_mail_analyses_current
  ON crm_contact_mail_analyses(actor_id,mailbox_key,message_key,contact_id,content_hash)
  WHERE is_current;
CREATE INDEX idx_crm_contact_mail_analyses_history
  ON crm_contact_mail_analyses(actor_id,mailbox_key,message_key,contact_id,content_hash,input_sequence DESC,created_at DESC);
CREATE INDEX idx_crm_contact_mail_analyses_contact
  ON crm_contact_mail_analyses(contact_id,customer_id,created_at DESC);
CREATE INDEX idx_crm_contact_mail_analyses_human
  ON crm_contact_mail_analyses(contact_id,customer_id)
  WHERE human_locked;

CREATE TABLE crm_contact_mail_task_suggestions (
  suggestion_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL REFERENCES public.identity_users(user_id),
  contact_id integer NOT NULL REFERENCES contacts(id),
  customer_id uuid NOT NULL REFERENCES crm_customers(customer_id),
  thread_key text NOT NULL,
  action_code text NOT NULL,
  source_analysis_id uuid NOT NULL REFERENCES crm_contact_mail_analyses(analysis_id),
  next_action text NOT NULL,
  priority text NOT NULL CHECK(priority IN ('normal','important','urgent')),
  due_hint text,
  status text NOT NULL DEFAULT 'suggested' CHECK(status IN ('suggested','dismissed','superseded')),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(actor_id,contact_id,thread_key,action_code),
  FOREIGN KEY(customer_id,contact_id) REFERENCES crm_customer_contacts(customer_id,contact_id)
);
CREATE INDEX idx_crm_contact_mail_task_suggestions_active
  ON crm_contact_mail_task_suggestions(actor_id,status,priority,updated_at DESC);
`;

export async function ensureContactMailAnalysisSchemaIn(client: PoolClient): Promise<Result<void>> {
  const existing = await client.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1', [CONTACT_MAIL_ANALYSIS_SCHEMA_VERSION]);
  if (existing.rows.length) {
    const checksum = createHash('sha256').update(CONTACT_MAIL_ANALYSIS_SQL).digest('hex');
    return existing.rows[0].checksum === checksum ? success(undefined) : failure('CONFLICT', '邮件分析迁移校验不一致');
  }
  return migrateContactMailAnalysisSchema(client);
}

export async function migrateContactMailAnalysisSchema(client: PoolClient): Promise<Result<void>> {
  const checksum = createHash('sha256').update(CONTACT_MAIL_ANALYSIS_SQL).digest('hex');
  const existing = await client.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1', [CONTACT_MAIL_ANALYSIS_SCHEMA_VERSION]);
  if (existing.rows.length) return existing.rows[0].checksum === checksum ? success(undefined) : failure('CONFLICT', '邮件分析迁移校验不一致');
  await client.query('SELECT pg_advisory_xact_lock($1)', [CONTACT_MAIL_ANALYSIS_LOCK]);
  const locked = await client.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1', [CONTACT_MAIL_ANALYSIS_SCHEMA_VERSION]);
  if (locked.rows.length) return locked.rows[0].checksum === checksum ? success(undefined) : failure('CONFLICT', '邮件分析迁移校验不一致');
  await client.query(CONTACT_MAIL_ANALYSIS_SQL);
  await client.query('INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)', [CONTACT_MAIL_ANALYSIS_SCHEMA_VERSION, checksum]);
  return success(undefined);
}
