export const DESKTOP_SCHEMA_VERSION = '007-desktop-session-rotation';
export const DESKTOP_SCHEMA_LOCK = 19041007;
export const DESKTOP_SCHEMA_SQL = `
CREATE TABLE identity.desktop_refresh_tokens (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  session_id uuid NOT NULL REFERENCES identity.sessions(session_id),
  absolute_expires_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (idle_expires_at <= absolute_expires_at)
);
CREATE INDEX idx_desktop_refresh_session ON identity.desktop_refresh_tokens(session_id);
`;
