export const TEAM_PRESENCE_VERSION = '071-team-presence-reads';

export const TEAM_PRESENCE_SQL = `
CREATE TABLE IF NOT EXISTS public.identity_desktop_presence (
  user_id uuid PRIMARY KEY REFERENCES public.identity_users(user_id),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_identity_desktop_presence_seen
  ON public.identity_desktop_presence(last_seen_at DESC);

CREATE TABLE IF NOT EXISTS crm_team_message_reads (
  team_id uuid NOT NULL REFERENCES crm_org_units(unit_id),
  user_id uuid NOT NULL REFERENCES public.identity_users(user_id),
  peer_user_id uuid NOT NULL REFERENCES public.identity_users(user_id),
  last_read_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(team_id,user_id,peer_user_id),
  CHECK(user_id<>peer_user_id)
);
`;
