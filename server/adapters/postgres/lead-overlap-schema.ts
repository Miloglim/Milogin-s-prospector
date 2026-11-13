import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { failure, success, type Result } from '../../core/crm';

export const LEAD_OVERLAP_VERSION = '065-lead-scope-overlaps';
export const LEAD_OVERLAP_LOCK = 650065;

export const LEAD_OVERLAP_SQL = `
DROP INDEX IF EXISTS idx_contacts_email;
CREATE INDEX IF NOT EXISTS idx_contacts_email_lookup ON contacts(lower(btrim(email)));

ALTER TABLE crm_customers DROP CONSTRAINT IF EXISTS crm_customers_source_customer_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_customers_scope_key
  ON crm_customers(source,customer_key,origin,COALESCE(owner_user_id,'00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE IF NOT EXISTS crm_lead_overlaps (
  overlap_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_contact_id integer NOT NULL REFERENCES contacts(id),
  target_contact_id integer NOT NULL REFERENCES contacts(id),
  source_customer_id uuid NOT NULL REFERENCES crm_customers(customer_id),
  target_customer_id uuid NOT NULL REFERENCES crm_customers(customer_id),
  match_type text NOT NULL CHECK(match_type IN ('same_email','same_company_country','similar_company')),
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','confirmed','ignored','won')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_contact_id,target_contact_id,match_type),
  CHECK(source_contact_id<>target_contact_id)
);
CREATE INDEX IF NOT EXISTS idx_crm_lead_overlaps_source ON crm_lead_overlaps(source_contact_id,status);
CREATE INDEX IF NOT EXISTS idx_crm_lead_overlaps_target ON crm_lead_overlaps(target_contact_id,status);

CREATE TABLE IF NOT EXISTS crm_deal_overlap_notices (
  notice_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  overlap_id uuid NOT NULL REFERENCES crm_lead_overlaps(overlap_id),
  winner_contact_id integer NOT NULL REFERENCES contacts(id),
  recipient_user_id uuid NOT NULL REFERENCES public.identity_users(user_id),
  opportunity_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','acknowledged','stop_requested','collaboration_requested')),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(opportunity_id,recipient_user_id,overlap_id)
);
CREATE INDEX IF NOT EXISTS idx_crm_deal_overlap_notices_recipient ON crm_deal_overlap_notices(recipient_user_id,status,created_at DESC);
`;

export async function migrateLeadOverlapSchema(c: PoolClient): Promise<Result<void>> {
  await c.query('SELECT pg_advisory_xact_lock($1)', [LEAD_OVERLAP_LOCK]);
  const checksum = createHash('sha256').update(LEAD_OVERLAP_SQL).digest('hex');
  const existing = await c.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1', [LEAD_OVERLAP_VERSION]);
  if (existing.rows.length) {
    if (existing.rows[0].checksum !== checksum) return failure('CONFLICT', '线索范围重叠迁移校验不一致');
    return success(undefined);
  }
  await c.query(LEAD_OVERLAP_SQL);
  await c.query('INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)', [LEAD_OVERLAP_VERSION, checksum]);
  return success(undefined);
}
