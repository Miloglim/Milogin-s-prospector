export const TEAM_SCHEMA_VERSION = '051-team-foundation-public';
export const TEAM_SCHEMA_LOCK = 19041051;
export const TEAM_TREE_VERSION = '052-team-tree-public';
export const TEAM_SCHEMA_SQL = `
CREATE TABLE crm_teams (
  team_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (btrim(name) <> '' AND char_length(btrim(name)) BETWEEN 2 AND 80),
  leader_user_id uuid NOT NULL REFERENCES public.identity_users(user_id),
  created_by uuid NOT NULL REFERENCES public.identity_users(user_id),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_crm_teams_name_ci ON crm_teams(lower(btrim(name)));

CREATE TABLE crm_team_members (
  team_id uuid NOT NULL REFERENCES crm_teams(team_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.identity_users(user_id),
  role text NOT NULL CHECK (role IN ('leader','member')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(team_id, user_id),
  UNIQUE(user_id)
);
CREATE INDEX idx_crm_team_members_team ON crm_team_members(team_id, role, joined_at);

CREATE TABLE crm_team_invitations (
  invitation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES crm_teams(team_id) ON DELETE CASCADE,
  inviter_user_id uuid NOT NULL REFERENCES public.identity_users(user_id),
  invitee_user_id uuid NOT NULL REFERENCES public.identity_users(user_id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','cancelled')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  CHECK (inviter_user_id <> invitee_user_id)
);
CREATE UNIQUE INDEX idx_crm_team_invitations_pending ON crm_team_invitations(team_id, invitee_user_id) WHERE status='pending';
CREATE INDEX idx_crm_team_invitations_invitee ON crm_team_invitations(invitee_user_id, status, created_at DESC);
CREATE INDEX idx_crm_team_invitations_team ON crm_team_invitations(team_id, status, created_at DESC);

CREATE TABLE crm_team_idempotency (
  actor_id uuid NOT NULL REFERENCES public.identity_users(user_id),
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  digest text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(actor_id, operation, idempotency_key)
);
`;

export const TEAM_TREE_SQL = `
ALTER TABLE crm_teams ADD COLUMN parent_team_id uuid REFERENCES crm_teams(team_id) ON DELETE RESTRICT;
DROP INDEX idx_crm_teams_name_ci;
CREATE UNIQUE INDEX idx_crm_teams_parent_name_ci ON crm_teams(COALESCE(parent_team_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(name)));
CREATE INDEX idx_crm_teams_parent ON crm_teams(parent_team_id, created_at, team_id);
`;
