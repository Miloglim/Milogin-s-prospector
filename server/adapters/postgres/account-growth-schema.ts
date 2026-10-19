export const ACCOUNT_GROWTH_SCHEMA_VERSION = "027-unified-account-growth";
export const ACCOUNT_GROWTH_SCHEMA_LOCK = 19041027;
export const ACCOUNT_GROWTH_SCHEMA_SQL = `
CREATE TABLE identity.account_experience_events (
  event_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity.users(user_id) ON DELETE CASCADE,
  source_product text NOT NULL CHECK (btrim(source_product) <> ''),
  event_type text NOT NULL CHECK (btrim(event_type) <> ''),
  subject_key text NOT NULL CHECK (btrim(subject_key) <> ''),
  points integer NOT NULL CHECK (points > 0),
  rule_version integer NOT NULL CHECK (rule_version > 0),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, source_product, event_type, subject_key)
);
CREATE INDEX idx_identity_growth_events_user_time
  ON identity.account_experience_events(user_id, occurred_at DESC, event_id);
CREATE TABLE identity.account_growth_projection (
  user_id uuid PRIMARY KEY REFERENCES identity.users(user_id) ON DELETE CASCADE,
  total_xp integer NOT NULL DEFAULT 0 CHECK (total_xp >= 0),
  cycle integer NOT NULL DEFAULT 1 CHECK (cycle > 0),
  level integer NOT NULL DEFAULT 1 CHECK (level > 0),
  today_xp integer NOT NULL DEFAULT 0 CHECK (today_xp >= 0),
  today_key date,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;
