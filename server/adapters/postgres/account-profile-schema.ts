export const ACCOUNT_PROFILE_SCHEMA_VERSION = "026-unified-account-profile";
export const ACCOUNT_PROFILE_SCHEMA_LOCK = 19041026;
export const ACCOUNT_PROFILE_SCHEMA_SQL = `
CREATE TABLE identity.user_profiles (
  user_id uuid PRIMARY KEY REFERENCES identity.users(user_id) ON DELETE CASCADE,
  avatar_id text NOT NULL DEFAULT 'default' CHECK (char_length(avatar_id) BETWEEN 1 AND 64),
  bio text NOT NULL DEFAULT '' CHECK (char_length(bio) <= 500),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE identity.login_aliases (
  alias text PRIMARY KEY CHECK (alias = lower(btrim(alias)) AND char_length(alias) BETWEEN 1 AND 128),
  user_id uuid NOT NULL REFERENCES identity.users(user_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_identity_login_aliases_user ON identity.login_aliases(user_id);
`;
