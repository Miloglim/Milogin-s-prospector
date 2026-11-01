export const ORGANIZATION_DISSOLUTION_VERSION = '064-organization-dissolution';

/**
 * Keeps organization rows, assignments and contacts for history while making
 * the dissolved unit and its ended assignments invisible to active queries.
 */
export const ORGANIZATION_DISSOLUTION_SQL = `
ALTER TABLE crm_org_units ADD COLUMN IF NOT EXISTS dissolved_at timestamptz;
ALTER TABLE crm_org_units ADD COLUMN IF NOT EXISTS dissolved_by uuid REFERENCES public.identity_users(user_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='crm_org_units_dissolution_pair_check'
  ) THEN
    ALTER TABLE crm_org_units ADD CONSTRAINT crm_org_units_dissolution_pair_check
      CHECK ((dissolved_at IS NULL AND dissolved_by IS NULL) OR (dissolved_at IS NOT NULL AND dissolved_by IS NOT NULL));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_crm_org_units_active_parent
  ON crm_org_units(parent_unit_id,kind,created_at,unit_id) WHERE dissolved_at IS NULL;
DROP INDEX IF EXISTS idx_crm_org_units_parent_name_ci;
CREATE UNIQUE INDEX idx_crm_org_units_parent_name_ci
  ON crm_org_units(COALESCE(parent_unit_id,'00000000-0000-0000-0000-000000000000'::uuid),lower(btrim(name)))
  WHERE dissolved_at IS NULL;

ALTER TABLE crm_org_assignments ADD COLUMN IF NOT EXISTS ended_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='crm_org_assignments_ended_after_created_check'
  ) THEN
    ALTER TABLE crm_org_assignments ADD CONSTRAINT crm_org_assignments_ended_after_created_check
      CHECK (ended_at IS NULL OR ended_at>=created_at);
  END IF;
END
$$;

DROP INDEX IF EXISTS idx_crm_org_assignments_member_once;
CREATE UNIQUE INDEX idx_crm_org_assignments_member_once
  ON crm_org_assignments(user_id) WHERE role='member' AND ended_at IS NULL;
DROP INDEX IF EXISTS idx_crm_org_assignments_primary_once;
CREATE UNIQUE INDEX idx_crm_org_assignments_primary_once
  ON crm_org_assignments(unit_id) WHERE role='leader' AND is_primary AND ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_org_assignments_active_unit
  ON crm_org_assignments(unit_id,role,created_at,user_id) WHERE ended_at IS NULL;

CREATE OR REPLACE FUNCTION crm_validate_org_assignment() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE unit_kind text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id::text, 0));
  SELECT kind INTO unit_kind FROM crm_org_units WHERE unit_id=NEW.unit_id AND dissolved_at IS NULL;
  IF unit_kind IS NULL OR unit_kind='company' THEN RAISE EXCEPTION 'organization unit is not assignable'; END IF;
  IF NEW.role='member' THEN
    IF unit_kind<>'sales_team' THEN RAISE EXCEPTION 'only sales teams accept members'; END IF;
    IF EXISTS(SELECT 1 FROM crm_org_assignments WHERE user_id=NEW.user_id AND role='leader' AND ended_at IS NULL) THEN
      RAISE EXCEPTION 'leader cannot also be an ordinary member';
    END IF;
  ELSIF NEW.role='leader' THEN
    IF EXISTS(SELECT 1 FROM crm_org_assignments WHERE user_id=NEW.user_id AND role='member' AND ended_at IS NULL) THEN
      RAISE EXCEPTION 'ordinary member cannot also be a leader';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS crm_org_dissolution_audits (
  audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id uuid NOT NULL UNIQUE REFERENCES crm_org_units(unit_id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES public.identity_users(user_id),
  unit_kind text NOT NULL CHECK (unit_kind IN ('operations_group','sales_team')),
  unit_name text NOT NULL,
  unit_version integer NOT NULL CHECK (unit_version>0),
  ended_assignment_count integer NOT NULL CHECK (ended_assignment_count>=0),
  cancelled_invitation_count integer NOT NULL CHECK (cancelled_invitation_count>=0),
  dissolved_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_org_dissolution_audits_actor
  ON crm_org_dissolution_audits(actor_user_id,dissolved_at DESC,audit_id DESC);

CREATE OR REPLACE FUNCTION crm_reject_org_dissolution_audit_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'organization dissolution audits are append-only';
END;
$$;
DROP TRIGGER IF EXISTS trg_crm_org_dissolution_audits_immutable ON crm_org_dissolution_audits;
CREATE TRIGGER trg_crm_org_dissolution_audits_immutable
BEFORE UPDATE OR DELETE ON crm_org_dissolution_audits
FOR EACH ROW EXECUTE FUNCTION crm_reject_org_dissolution_audit_change();
`;
