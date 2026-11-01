import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { failure, success, type Result } from '../../core/crm';

export const CONTACT_ASSIGNMENT_STATE_VERSION = '057-contact-assignment-state';
export const CONTACT_ASSIGNMENT_STATE_LOCK = 570057;

export const CONTACT_ASSIGNMENT_STATE_SQL = `
DO $$
BEGIN
  IF to_regclass('crm_org_units') IS NULL
     OR to_regclass('crm_org_assignments') IS NULL THEN
    RAISE EXCEPTION '057 requires canonical organization tables';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM crm_schema_migrations WHERE version='055-organization-canonical')
     OR NOT EXISTS (SELECT 1 FROM crm_schema_migrations WHERE version='056-organization-assignment-integrity') THEN
    RAISE EXCEPTION '057 requires canonical organization migrations';
  END IF;
END
$$;

ALTER TABLE crm_contact_assignment_requests
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS previous_target_user_id uuid REFERENCES public.identity_users(user_id),
  ADD COLUMN IF NOT EXISTS transfer_actor_id uuid REFERENCES public.identity_users(user_id),
  ADD COLUMN IF NOT EXISTS transfer_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS source_org_unit_name text;

UPDATE crm_contact_assignment_requests request
SET source_org_unit_name=unit.name
FROM crm_org_units unit
WHERE request.source_org_unit_id=unit.unit_id
  AND request.source_org_unit_name IS NULL;

UPDATE crm_contact_assignment_requests
SET expires_at=created_at+interval '7 days'
WHERE expires_at IS NULL;

ALTER TABLE crm_contact_assignment_requests
  ALTER COLUMN expires_at SET DEFAULT (now()+interval '7 days'),
  ALTER COLUMN expires_at SET NOT NULL;

ALTER TABLE crm_contact_assignment_requests
  DROP CONSTRAINT IF EXISTS crm_contact_assignment_requests_status_check;
ALTER TABLE crm_contact_assignment_requests
  ADD CONSTRAINT crm_contact_assignment_status_valid
  CHECK(status IN ('pending','accepted','rejected','cancelled','expired','pending_transfer'));

DROP INDEX IF EXISTS idx_crm_contact_active_assignment;
CREATE UNIQUE INDEX idx_crm_contact_active_assignment
  ON crm_contact_assignment_requests(contact_id)
  WHERE status IN ('pending','accepted','pending_transfer');
CREATE INDEX idx_crm_contact_assignment_expiry
  ON crm_contact_assignment_requests(expires_at,request_id)
  WHERE status IN ('pending','pending_transfer');
CREATE INDEX idx_crm_contact_assignment_supervisor_active
  ON crm_contact_assignment_requests USING gin(supervisor_user_ids)
  WHERE status IN ('pending','accepted','expired','pending_transfer');

CREATE TABLE crm_contact_ownership (
  ownership_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id integer NOT NULL REFERENCES contacts(id),
  customer_id uuid NOT NULL REFERENCES crm_customers(customer_id),
  owner_user_id uuid NOT NULL REFERENCES public.identity_users(user_id),
  assignment_request_id uuid REFERENCES crm_contact_assignment_requests(request_id),
  source_org_unit_id uuid REFERENCES crm_org_units(unit_id),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  ended_reason text,
  created_by uuid NOT NULL REFERENCES public.identity_users(user_id),
  CHECK(ended_at IS NULL OR ended_at>=started_at),
  FOREIGN KEY(customer_id,contact_id) REFERENCES crm_customer_contacts(customer_id,contact_id)
);
CREATE UNIQUE INDEX idx_crm_contact_ownership_current
  ON crm_contact_ownership(contact_id) WHERE ended_at IS NULL;
CREATE INDEX idx_crm_contact_ownership_history
  ON crm_contact_ownership(contact_id,started_at DESC,ownership_id DESC);
CREATE INDEX idx_crm_contact_ownership_owner
  ON crm_contact_ownership(owner_user_id,ended_at,contact_id);

INSERT INTO crm_contact_ownership(
  contact_id,customer_id,owner_user_id,assignment_request_id,source_org_unit_id,
  started_at,created_by
)
SELECT DISTINCT ON (r.contact_id)
  r.contact_id,r.customer_id,r.target_user_id,r.request_id,r.source_org_unit_id,
  COALESCE(r.decided_at,r.created_at),r.target_user_id
FROM crm_contact_assignment_requests r
WHERE r.status='accepted'
ORDER BY r.contact_id,COALESCE(r.decided_at,r.created_at) DESC,r.request_id DESC
ON CONFLICT DO NOTHING;

CREATE TABLE crm_contact_monitor_audits (
  audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL REFERENCES public.identity_users(user_id),
  contact_id integer NOT NULL REFERENCES contacts(id),
  customer_id uuid NOT NULL REFERENCES crm_customers(customer_id),
  relationship text NOT NULL CHECK(relationship='direct_leader'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(customer_id,contact_id) REFERENCES crm_customer_contacts(customer_id,contact_id)
);
CREATE INDEX idx_crm_contact_monitor_audits_actor
  ON crm_contact_monitor_audits(actor_id,created_at DESC,audit_id DESC);
CREATE INDEX idx_crm_contact_monitor_audits_contact
  ON crm_contact_monitor_audits(contact_id,created_at DESC,audit_id DESC);
`;

export async function migrateContactAssignmentState(client: PoolClient): Promise<Result<void>> {
  const checksum = createHash('sha256').update(CONTACT_ASSIGNMENT_STATE_SQL).digest('hex');
  const old = await client.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1', [CONTACT_ASSIGNMENT_STATE_VERSION]);
  if (old.rows.length && old.rows[0].checksum !== checksum) {
    return failure('CONFLICT', '联系人分配状态迁移校验不一致');
  }
  if (!old.rows.length) {
    await client.query(CONTACT_ASSIGNMENT_STATE_SQL);
    await client.query('INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)', [CONTACT_ASSIGNMENT_STATE_VERSION, checksum]);
  }
  return success(undefined);
}
