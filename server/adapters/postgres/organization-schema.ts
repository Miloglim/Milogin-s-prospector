import { TEAM_INVITATION_TTL_SECONDS } from '../../core/teams';

export const ORGANIZATION_SCHEMA_VERSION = '055-organization-canonical';
export const ORGANIZATION_ASSIGNMENT_INTEGRITY_VERSION = '056-organization-assignment-integrity';
export const LEGACY_ORGANIZATION_REPAIR_VERSION = '054a-legacy-organization-repair';

/** 052 allowed arbitrary trees; normalize the historical shape before the canonical precheck. */
export const LEGACY_ORGANIZATION_REPAIR_SQL = `
UPDATE crm_teams t
SET unit_type='operations',updated_at=now()
WHERE EXISTS(SELECT 1 FROM crm_teams child WHERE child.parent_team_id=t.team_id);

UPDATE crm_teams
SET parent_team_id=NULL,updated_at=now()
WHERE unit_type='operations' AND parent_team_id IS NOT NULL;
`;

export const ORGANIZATION_SCHEMA_SQL = `
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM crm_teams child
    JOIN crm_teams parent ON parent.team_id=child.parent_team_id
    WHERE (child.unit_type='sales_team' AND parent.unit_type='sales_team')
       OR child.unit_type='operations'
  ) THEN
    RAISE EXCEPTION 'unsupported legacy organization hierarchy';
  END IF;

  IF (SELECT count(*) FROM crm_teams) <> (
    WITH RECURSIVE reachable(team_id) AS (
      SELECT team_id FROM crm_teams WHERE parent_team_id IS NULL
      UNION ALL
      SELECT child.team_id FROM crm_teams child JOIN reachable parent ON child.parent_team_id=parent.team_id
    )
    SELECT count(*) FROM reachable
  ) THEN
    RAISE EXCEPTION 'unsupported legacy organization cycle';
  END IF;
END
$$;

CREATE TABLE crm_org_units (
  unit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('company','operations_group','sales_team')),
  parent_unit_id uuid REFERENCES crm_org_units(unit_id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (btrim(name) <> '' AND char_length(btrim(name)) BETWEEN 2 AND 80),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid REFERENCES public.identity_users(user_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'company' AND parent_unit_id IS NULL) OR (kind <> 'company' AND parent_unit_id IS NOT NULL)),
  CHECK (kind = 'company' OR created_by IS NOT NULL)
);
CREATE UNIQUE INDEX idx_crm_org_units_company ON crm_org_units(kind) WHERE kind='company';
CREATE UNIQUE INDEX idx_crm_org_units_parent_name_ci
  ON crm_org_units(COALESCE(parent_unit_id,'00000000-0000-0000-0000-000000000000'::uuid),lower(btrim(name)));
CREATE INDEX idx_crm_org_units_parent ON crm_org_units(parent_unit_id, kind, created_at, unit_id);

CREATE OR REPLACE FUNCTION crm_validate_org_unit_hierarchy() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_kind text;
  cycle_found boolean;
BEGIN
  IF NEW.kind='company' THEN
    IF NEW.parent_unit_id IS NOT NULL THEN RAISE EXCEPTION 'company root cannot have a parent'; END IF;
    RETURN NEW;
  END IF;
  SELECT kind INTO parent_kind FROM crm_org_units WHERE unit_id=NEW.parent_unit_id;
  IF parent_kind IS NULL THEN RAISE EXCEPTION 'organization parent does not exist'; END IF;
  IF parent_kind='sales_team' THEN RAISE EXCEPTION 'sales teams are leaves'; END IF;
  IF NEW.kind='operations_group' AND parent_kind<>'company' THEN RAISE EXCEPTION 'operations groups must be under the company'; END IF;
  IF NEW.kind='sales_team' AND parent_kind NOT IN ('company','operations_group') THEN RAISE EXCEPTION 'sales teams must be under the company or an operations group'; END IF;
  IF TG_OP='UPDATE' AND NEW.parent_unit_id IS DISTINCT FROM OLD.parent_unit_id THEN
    WITH RECURSIVE ancestors(unit_id,parent_unit_id) AS (
      SELECT unit_id,parent_unit_id FROM crm_org_units WHERE unit_id=NEW.parent_unit_id
      UNION ALL
      SELECT u.unit_id,u.parent_unit_id FROM crm_org_units u JOIN ancestors a ON u.unit_id=a.parent_unit_id
    ) SELECT EXISTS(SELECT 1 FROM ancestors WHERE unit_id=NEW.unit_id) INTO cycle_found;
    IF cycle_found THEN RAISE EXCEPTION 'organization cycle'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_crm_org_unit_hierarchy BEFORE INSERT OR UPDATE OF parent_unit_id,kind ON crm_org_units
FOR EACH ROW EXECUTE FUNCTION crm_validate_org_unit_hierarchy();

CREATE TABLE crm_org_assignments (
  user_id uuid NOT NULL REFERENCES public.identity_users(user_id) ON DELETE CASCADE,
  unit_id uuid NOT NULL REFERENCES crm_org_units(unit_id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('leader','member')),
  is_primary boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, unit_id, role),
  UNIQUE(unit_id, user_id),
  CHECK (NOT is_primary OR role='leader')
);
CREATE UNIQUE INDEX idx_crm_org_assignments_member_once ON crm_org_assignments(user_id) WHERE role='member';
CREATE UNIQUE INDEX idx_crm_org_assignments_primary_once
  ON crm_org_assignments(unit_id) WHERE role='leader' AND is_primary;
CREATE INDEX idx_crm_org_assignments_unit ON crm_org_assignments(unit_id, role, created_at, user_id);

CREATE OR REPLACE FUNCTION crm_validate_org_assignment() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE unit_kind text;
BEGIN
  SELECT kind INTO unit_kind FROM crm_org_units WHERE unit_id=NEW.unit_id;
  IF unit_kind IS NULL OR unit_kind='company' THEN RAISE EXCEPTION 'company root does not accept assignments'; END IF;
  IF NEW.role='member' AND unit_kind<>'sales_team' THEN RAISE EXCEPTION 'only sales teams accept members'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_crm_org_assignment_kind BEFORE INSERT OR UPDATE OF unit_id,role ON crm_org_assignments
FOR EACH ROW EXECUTE FUNCTION crm_validate_org_assignment();

CREATE TABLE crm_org_invitations (
  invitation_id uuid PRIMARY KEY,
  unit_id uuid NOT NULL REFERENCES crm_org_units(unit_id) ON DELETE CASCADE,
  inviter_user_id uuid NOT NULL REFERENCES public.identity_users(user_id),
  invitee_user_id uuid NOT NULL REFERENCES public.identity_users(user_id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','cancelled','expired')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+(${TEAM_INVITATION_TTL_SECONDS} * interval '1 second'),
  decided_at timestamptz,
  CHECK (inviter_user_id <> invitee_user_id)
);
CREATE UNIQUE INDEX idx_crm_org_invitations_pending ON crm_org_invitations(unit_id, invitee_user_id) WHERE status='pending';
CREATE INDEX idx_crm_org_invitations_invitee ON crm_org_invitations(invitee_user_id, status, created_at DESC);
CREATE INDEX idx_crm_org_invitations_unit ON crm_org_invitations(unit_id, status, created_at DESC);

CREATE TABLE crm_org_idempotency (
  actor_id uuid NOT NULL REFERENCES public.identity_users(user_id) ON DELETE CASCADE,
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  digest text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(actor_id, operation, idempotency_key)
);

CREATE TABLE crm_org_member_groups (
  group_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id uuid NOT NULL REFERENCES crm_org_units(unit_id) ON DELETE CASCADE,
  name text NOT NULL CHECK (btrim(name) <> '' AND char_length(btrim(name)) BETWEEN 1 AND 40),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_crm_org_member_groups_name_ci ON crm_org_member_groups(unit_id, lower(btrim(name)));
CREATE TABLE crm_org_member_group_members (
  group_id uuid NOT NULL REFERENCES crm_org_member_groups(group_id) ON DELETE CASCADE,
  unit_id uuid NOT NULL,
  user_id uuid NOT NULL,
  PRIMARY KEY(group_id, user_id),
  UNIQUE(unit_id, user_id),
  FOREIGN KEY(unit_id, user_id) REFERENCES crm_org_assignments(unit_id, user_id) ON DELETE CASCADE
);

INSERT INTO crm_org_units(kind,parent_unit_id,name,version,created_by,created_at,updated_at)
VALUES('company',NULL,'Milogin',1,NULL,now(),now());

WITH RECURSIVE legacy_tree AS (
  SELECT t.*,0 AS depth
  FROM crm_teams t
  WHERE t.parent_team_id IS NULL
  UNION ALL
  SELECT child.*,parent.depth+1
  FROM crm_teams child
  JOIN legacy_tree parent ON child.parent_team_id=parent.team_id
), mapped AS (
  SELECT t.team_id,
    CASE t.unit_type WHEN 'operations' THEN 'operations_group' ELSE 'sales_team' END AS kind,
    CASE WHEN t.parent_team_id IS NULL THEN company.unit_id ELSE t.parent_team_id END AS parent_unit_id,
    t.name,t.version,t.created_by,t.created_at,t.updated_at,t.depth
  FROM legacy_tree t
  CROSS JOIN (SELECT unit_id FROM crm_org_units WHERE kind='company') company
)
INSERT INTO crm_org_units(unit_id,kind,parent_unit_id,name,version,created_by,created_at,updated_at)
SELECT team_id,kind,parent_unit_id,name,version,created_by,created_at,updated_at
FROM mapped
ORDER BY depth,team_id;

INSERT INTO crm_org_assignments(user_id,unit_id,role,is_primary,created_at,updated_at)
SELECT leader_user_id,team_id,'leader',true,created_at,updated_at
FROM crm_teams
ON CONFLICT DO NOTHING;

INSERT INTO crm_org_assignments(user_id,unit_id,role,is_primary,created_at,updated_at)
SELECT m.user_id,m.team_id,'member',false,m.joined_at,m.joined_at
FROM crm_team_members m JOIN crm_teams t USING(team_id)
WHERE m.role='member' AND m.user_id<>t.leader_user_id AND t.unit_type='sales_team'
ON CONFLICT DO NOTHING;

INSERT INTO crm_org_invitations(invitation_id,unit_id,inviter_user_id,invitee_user_id,status,version,created_at,expires_at,decided_at)
SELECT invitation_id,team_id,inviter_user_id,invitee_user_id,status,version,created_at,
  created_at+(${TEAM_INVITATION_TTL_SECONDS} * interval '1 second'),decided_at
FROM crm_team_invitations;

INSERT INTO crm_org_idempotency(actor_id,operation,idempotency_key,digest,response,created_at)
SELECT actor_id,operation,idempotency_key,digest,response,created_at FROM crm_team_idempotency;

INSERT INTO crm_org_member_groups(group_id,unit_id,name,version,created_at,updated_at)
SELECT g.group_id,g.team_id,g.name,g.version,g.created_at,g.created_at FROM crm_team_member_groups g;
INSERT INTO crm_org_member_group_members(group_id,unit_id,user_id)
SELECT gm.group_id,gm.team_id,gm.user_id FROM crm_team_member_group_members gm;

ALTER TABLE crm_contact_assignment_requests
  ADD COLUMN source_org_unit_id uuid REFERENCES crm_org_units(unit_id);
UPDATE crm_contact_assignment_requests r
SET source_org_unit_id=r.source_unit_id
WHERE r.source_unit_id IS NOT NULL AND EXISTS(SELECT 1 FROM crm_org_units u WHERE u.unit_id=r.source_unit_id);
CREATE INDEX idx_crm_contact_assignment_source_org
  ON crm_contact_assignment_requests(source_org_unit_id, status, created_at DESC);

COMMENT ON TABLE crm_teams IS 'Frozen after 055; compatibility source only. Runtime writes crm_org_units.';
COMMENT ON TABLE crm_team_members IS 'Frozen after 055; compatibility source only. Runtime writes crm_org_assignments.';
COMMENT ON TABLE crm_team_invitations IS 'Frozen after 055; compatibility source only. Runtime writes crm_org_invitations.';
COMMENT ON TABLE crm_team_idempotency IS 'Frozen after 055; compatibility source only. Runtime writes crm_org_idempotency.';
COMMENT ON TABLE crm_team_member_groups IS 'Frozen after 055; compatibility source only. Runtime writes crm_org_member_groups.';
COMMENT ON TABLE crm_team_member_group_members IS 'Frozen after 055; compatibility source only. Runtime writes crm_org_member_group_members.';
`;

/**
 * 055 established the canonical organization tables. This follow-up makes the
 * member/leader exclusivity rule effective for direct DB writes as well as the
 * service path, and serializes assignment writes for the same user.
 */
export const ORGANIZATION_ASSIGNMENT_INTEGRITY_SQL = `
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM crm_org_assignments
    GROUP BY user_id
    HAVING bool_or(role='member') AND bool_or(role='leader')
  ) THEN
    RAISE EXCEPTION 'existing organization assignments violate member/leader exclusivity';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION crm_validate_org_unit_hierarchy() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_kind text;
  cycle_found boolean;
BEGIN
  IF NEW.kind='company' THEN
    IF NEW.parent_unit_id IS NOT NULL THEN RAISE EXCEPTION 'company root cannot have a parent'; END IF;
    RETURN NEW;
  END IF;
  SELECT kind INTO parent_kind FROM crm_org_units WHERE unit_id=NEW.parent_unit_id;
  IF parent_kind IS NULL THEN RAISE EXCEPTION 'organization parent does not exist'; END IF;
  IF parent_kind='sales_team' THEN RAISE EXCEPTION 'sales teams are leaves'; END IF;
  IF NEW.kind='operations_group' AND parent_kind<>'company' THEN RAISE EXCEPTION 'operations groups must be under the company'; END IF;
  IF NEW.kind='sales_team' AND parent_kind NOT IN ('company','operations_group') THEN RAISE EXCEPTION 'sales teams must be under the company or an operations group'; END IF;
  IF TG_OP='UPDATE' AND NEW.parent_unit_id IS DISTINCT FROM OLD.parent_unit_id THEN
    WITH RECURSIVE ancestors(unit_id,parent_unit_id) AS (
      SELECT unit_id,parent_unit_id FROM crm_org_units WHERE unit_id=NEW.parent_unit_id
      UNION ALL SELECT u.unit_id,u.parent_unit_id FROM crm_org_units u JOIN ancestors a ON u.unit_id=a.parent_unit_id
    ) SELECT EXISTS(SELECT 1 FROM ancestors WHERE unit_id=NEW.unit_id) INTO cycle_found;
    IF cycle_found THEN RAISE EXCEPTION 'organization cycle'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_crm_org_unit_hierarchy ON crm_org_units;
CREATE TRIGGER trg_crm_org_unit_hierarchy BEFORE INSERT OR UPDATE OF parent_unit_id,kind ON crm_org_units
FOR EACH ROW EXECUTE FUNCTION crm_validate_org_unit_hierarchy();

CREATE OR REPLACE FUNCTION crm_validate_org_assignment() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE unit_kind text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id::text, 0));
  SELECT kind INTO unit_kind FROM crm_org_units WHERE unit_id=NEW.unit_id;
  IF unit_kind IS NULL OR unit_kind='company' THEN RAISE EXCEPTION 'company root does not accept assignments'; END IF;
  IF NEW.role='member' THEN
    IF unit_kind<>'sales_team' THEN RAISE EXCEPTION 'only sales teams accept members'; END IF;
    IF EXISTS(SELECT 1 FROM crm_org_assignments WHERE user_id=NEW.user_id AND role='leader') THEN
      RAISE EXCEPTION 'leader cannot also be an ordinary member';
    END IF;
  ELSIF NEW.role='leader' THEN
    IF EXISTS(SELECT 1 FROM crm_org_assignments WHERE user_id=NEW.user_id AND role='member') THEN
      RAISE EXCEPTION 'ordinary member cannot also be a leader';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_crm_org_assignment_kind ON crm_org_assignments;
CREATE TRIGGER trg_crm_org_assignment_kind BEFORE INSERT OR UPDATE OF user_id,unit_id,role ON crm_org_assignments
FOR EACH ROW EXECUTE FUNCTION crm_validate_org_assignment();
`;
