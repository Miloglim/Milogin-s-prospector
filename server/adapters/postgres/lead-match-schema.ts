import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { failure, success, type Result } from '../../core/crm';

export const LEAD_MATCH_SCHEMA_VERSION = '058-lead-ingress-conflict';
export const LEAD_MATCH_LOCK = 580058;

export const LEAD_MATCH_SQL = `
DO $$
BEGIN
  IF to_regclass('contacts') IS NULL OR to_regclass('crm_customer_contacts') IS NULL THEN
    RAISE EXCEPTION '058 requires CRM contacts';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM crm_schema_migrations WHERE version='057-contact-assignment-state') THEN
    RAISE EXCEPTION '058 requires assignment ownership state';
  END IF;
END
$$;

CREATE TABLE crm_lead_match_decisions (
  decision_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL REFERENCES public.identity_users(user_id),
  ingress_source text NOT NULL,
  idempotency_key text NOT NULL,
  request_digest text NOT NULL,
  status text NOT NULL CHECK(status IN ('allowed','duplicate','restricted_conflict','needs_resolution','resolved')),
  conflict_level text NOT NULL CHECK(conflict_level IN ('exact_email','exact_domain','exact_company','strong_company','weak_company','none')),
  action text CHECK(action IN ('create_new','attach_company','restore')),
  message text NOT NULL,
  original_values jsonb NOT NULL,
  normalized_email text NOT NULL DEFAULT '',
  normalized_domain text NOT NULL DEFAULT '',
  normalized_company text NOT NULL DEFAULT '',
  normalized_country text NOT NULL DEFAULT '',
  candidate_contact_ids integer[] NOT NULL DEFAULT '{}',
  candidate_customer_ids uuid[] NOT NULL DEFAULT '{}',
  candidate_company_ids integer[] NOT NULL DEFAULT '{}',
  candidate_scores numeric[] NOT NULL DEFAULT '{}',
  candidate_levels text[] NOT NULL DEFAULT '{}',
  selected_contact_id integer REFERENCES contacts(id),
  selected_customer_id uuid REFERENCES crm_customers(customer_id),
  selected_company_id integer REFERENCES companies(id),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  resolution_key text,
  resolution_digest text,
  resolution_response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE(actor_id,ingress_source,idempotency_key)
);
CREATE INDEX idx_crm_lead_match_decisions_actor_status
  ON crm_lead_match_decisions(actor_id,status,created_at DESC,decision_id DESC);
CREATE INDEX idx_crm_lead_match_decisions_email
  ON crm_lead_match_decisions(normalized_email)
  WHERE normalized_email<>'';
CREATE INDEX idx_crm_lead_match_decisions_domain
  ON crm_lead_match_decisions(normalized_domain)
  WHERE normalized_domain<>'';
CREATE INDEX idx_crm_lead_match_decisions_company
  ON crm_lead_match_decisions(normalized_company,normalized_country)
  WHERE normalized_company<>'';
CREATE INDEX idx_crm_lead_match_decisions_selected_contact
  ON crm_lead_match_decisions(selected_contact_id)
  WHERE selected_contact_id IS NOT NULL;
`;

export async function migrateLeadMatchSchema(client: PoolClient): Promise<Result<void>> {
  const checksum = createHash('sha256').update(LEAD_MATCH_SQL).digest('hex');
  const existing = await client.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1', [LEAD_MATCH_SCHEMA_VERSION]);
  if (existing.rows.length) return existing.rows[0].checksum === checksum ? success(undefined) : failure('CONFLICT', '线索冲突迁移校验不一致');
  await client.query('SELECT pg_advisory_xact_lock($1)', [LEAD_MATCH_LOCK]);
  const locked = await client.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1', [LEAD_MATCH_SCHEMA_VERSION]);
  if (locked.rows.length) return locked.rows[0].checksum === checksum ? success(undefined) : failure('CONFLICT', '线索冲突迁移校验不一致');
  if (!locked.rows.length) {
    await client.query(LEAD_MATCH_SQL);
    await client.query('INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)', [LEAD_MATCH_SCHEMA_VERSION, checksum]);
  }
  return success(undefined);
}
