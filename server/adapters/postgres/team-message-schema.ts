export const TEAM_MESSAGE_VERSION = '069-team-direct-messages';

export const TEAM_MESSAGE_SQL = `
CREATE TABLE IF NOT EXISTS crm_team_messages (
  message_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES crm_org_units(unit_id),
  sender_user_id uuid NOT NULL REFERENCES public.identity_users(user_id),
  recipient_user_id uuid NOT NULL REFERENCES public.identity_users(user_id),
  body text NOT NULL CHECK(btrim(body)<>'' AND char_length(body)<=2000),
  operation_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(sender_user_id<>recipient_user_id)
);
CREATE INDEX IF NOT EXISTS idx_crm_team_messages_pair
  ON crm_team_messages(team_id,sender_user_id,recipient_user_id,created_at,message_id);
`;
