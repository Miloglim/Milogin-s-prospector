export const SAMPLE_MAIL_SCHEMA_VERSION = '075-sample-mail';

export const SAMPLE_MAIL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS crm_sample_mail_packages (
  package_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES public.identity_users(user_id),
  account_email text NOT NULL CHECK (btrim(account_email) <> '' AND char_length(account_email) <= 320),
  filename text NOT NULL CHECK (btrim(filename) <> '' AND char_length(filename) <= 160),
  message_count integer NOT NULL CHECK (message_count > 0 AND message_count <= 500),
  bytes bigint NOT NULL CHECK (bytes > 0 AND bytes <= 25165824),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  storage_key text NOT NULL CHECK (btrim(storage_key) <> ''),
  range_from text,
  range_to text,
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_crm_sample_mail_owner
  ON crm_sample_mail_packages(owner_user_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_sample_mail_expiry
  ON crm_sample_mail_packages(expires_at) WHERE deleted_at IS NULL;
`;
