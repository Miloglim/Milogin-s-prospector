export const AUTH_SCHEMA_VERSION = "002-identity-foundation-public";
export const AUTH_SCHEMA_LOCK = 19041002;
export const AUTH_SCHEMA_SQL = `
CREATE TABLE public.identity_users (
  user_id uuid PRIMARY KEY, display_name text NOT NULL CHECK (btrim(display_name) <> ''),
  active boolean NOT NULL DEFAULT true, identity_admin boolean NOT NULL DEFAULT false,
  security_revision integer NOT NULL DEFAULT 1 CHECK (security_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.identity_login_emails (
  user_id uuid PRIMARY KEY REFERENCES public.identity_users(user_id),
  email text NOT NULL UNIQUE CHECK (email=lower(btrim(email)) AND email<>''), verified_at timestamptz
);
CREATE TABLE public.identity_credentials (
  user_id uuid PRIMARY KEY REFERENCES public.identity_users(user_id), password_hash text NOT NULL,
  hash_scheme text NOT NULL CHECK (hash_scheme='scrypt-v1'), changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.identity_product_grants (
  user_id uuid NOT NULL REFERENCES public.identity_users(user_id),
  product_id text NOT NULL CHECK (product_id='crm'), role text NOT NULL CHECK (role IN ('admin','operations','sales')),
  active boolean NOT NULL DEFAULT true, PRIMARY KEY(user_id,product_id,role)
);
CREATE TABLE public.identity_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid NOT NULL REFERENCES public.identity_users(user_id), security_revision integer NOT NULL,
  expires_at timestamptz NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);
CREATE INDEX idx_identity_sessions_user ON public.identity_sessions(user_id);
CREATE INDEX idx_identity_sessions_expiry ON public.identity_sessions(expires_at);
CREATE TABLE public.identity_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id uuid REFERENCES public.identity_users(user_id),
  event text NOT NULL CHECK (event IN ('login','logout','fixture')),
  created_at timestamptz NOT NULL DEFAULT now()
);
`;
