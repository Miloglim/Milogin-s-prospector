export const UNIFORM_TEAM_MEMBERSHIP_VERSION = '068-uniform-team-membership';

export const UNIFORM_TEAM_MEMBERSHIP_SQL = `
CREATE OR REPLACE FUNCTION crm_validate_org_assignment() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE unit_kind text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id::text, 0));
  SELECT kind INTO unit_kind FROM crm_org_units WHERE unit_id=NEW.unit_id;
  IF unit_kind IS NULL OR unit_kind='company' THEN RAISE EXCEPTION 'company root does not accept assignments'; END IF;
  IF NEW.role='member' THEN
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
`;
