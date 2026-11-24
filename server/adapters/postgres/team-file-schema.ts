export const TEAM_FILE_VERSION = '074-team-files';

export const TEAM_FILE_SQL = `
CREATE TABLE IF NOT EXISTS crm_team_files (
  file_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES crm_org_units(unit_id),
  purpose text NOT NULL CHECK(purpose IN ('team_attachment')),
  filename text NOT NULL CHECK(btrim(filename)<>'' AND char_length(filename)<=240),
  mime_type text NOT NULL CHECK(btrim(mime_type)<>'' AND char_length(mime_type)<=160),
  bytes bigint NOT NULL CHECK(bytes>0 AND bytes<=8388608),
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  storage_key text NOT NULL CHECK(btrim(storage_key)<>''),
  owner_user_id uuid NOT NULL REFERENCES public.identity_users(user_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  UNIQUE(team_id,purpose,sha256)
);
CREATE INDEX IF NOT EXISTS idx_crm_team_files_team ON crm_team_files(team_id,created_at DESC) WHERE deleted_at IS NULL;
ALTER TABLE crm_team_messages
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'text' CHECK(kind IN ('text','attachment')),
  ADD COLUMN IF NOT EXISTS payload_json jsonb;
`;
