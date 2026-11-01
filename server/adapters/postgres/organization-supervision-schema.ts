export const ORG_SUPERVISION_VERSION = '053-org-supervision-public';

export const ORG_SUPERVISION_SQL = `
ALTER TABLE crm_teams ADD COLUMN unit_type text NOT NULL DEFAULT 'sales_team'
  CHECK (unit_type IN ('operations','sales_team'));
CREATE INDEX idx_crm_teams_unit_type ON crm_teams(unit_type, parent_team_id, created_at);

CREATE TABLE crm_team_member_groups (
  group_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES crm_teams(team_id) ON DELETE CASCADE,
  name text NOT NULL CHECK (btrim(name) <> '' AND char_length(btrim(name)) BETWEEN 1 AND 40),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(team_id, name)
);
CREATE TABLE crm_team_member_group_members (
  group_id uuid NOT NULL REFERENCES crm_team_member_groups(group_id) ON DELETE CASCADE,
  team_id uuid NOT NULL,
  user_id uuid NOT NULL,
  PRIMARY KEY(group_id, user_id),
  FOREIGN KEY(team_id, user_id) REFERENCES crm_team_members(team_id, user_id) ON DELETE CASCADE,
  UNIQUE(user_id)
);

ALTER TABLE crm_contact_assignment_requests
  ADD COLUMN supervisor_user_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE crm_contact_assignment_requests
  ADD COLUMN source_unit_id uuid REFERENCES crm_teams(team_id);
CREATE INDEX idx_crm_contact_assignment_supervisor
  ON crm_contact_assignment_requests USING gin(supervisor_user_ids)
  WHERE status='accepted';
`;

export const TEAM_ORGANIZATION_VERSION = '054-team-organization-public';

export const TEAM_ORGANIZATION_SQL = `
CREATE INDEX idx_crm_teams_leader_unit
  ON crm_teams(leader_user_id, unit_type, team_id);
CREATE INDEX idx_crm_team_member_groups_team_order
  ON crm_team_member_groups(team_id, name, group_id);
`;
