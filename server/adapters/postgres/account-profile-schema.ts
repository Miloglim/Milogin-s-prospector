export const ACCOUNT_PROFILE_SCHEMA_VERSION = "026-unified-account-profile-public";
export const ACCOUNT_PROFILE_SCHEMA_LOCK = 19041026;
export const ACCOUNT_PROFILE_SCHEMA_SQL = `
CREATE TABLE public.identity_user_profiles (
  user_id uuid PRIMARY KEY REFERENCES public.identity_users(user_id) ON DELETE CASCADE,
  avatar_id text NOT NULL DEFAULT 'default' CHECK (char_length(avatar_id) BETWEEN 1 AND 64),
  bio text NOT NULL DEFAULT '' CHECK (char_length(bio) <= 500),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.identity_login_aliases (
  alias text PRIMARY KEY CHECK (alias = lower(btrim(alias)) AND char_length(alias) BETWEEN 1 AND 128),
  user_id uuid NOT NULL REFERENCES public.identity_users(user_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_identity_login_aliases_user ON public.identity_login_aliases(user_id);
`;
