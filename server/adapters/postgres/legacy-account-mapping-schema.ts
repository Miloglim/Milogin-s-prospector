export const LEGACY_ACCOUNT_MAPPING_SCHEMA_VERSION = "029-legacy-account-mapping";
export const LEGACY_ACCOUNT_MAPPING_SCHEMA_LOCK = 19041029;
export const LEGACY_ACCOUNT_MAPPING_SCHEMA_SQL = `
CREATE TABLE identity.legacy_account_mappings (
  source_product text NOT NULL CHECK (source_product = 'navigator'),
  legacy_user_id text NOT NULL CHECK (btrim(legacy_user_id) <> ''),
  legacy_login_alias text NOT NULL CHECK (legacy_login_alias = lower(btrim(legacy_login_alias))),
  center_user_id uuid REFERENCES identity.users(user_id),
  status text NOT NULL CHECK (status IN ('pending','matched','needs_review','migrated','rejected')),
  requires_password_reset boolean NOT NULL DEFAULT true,
  reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_product, legacy_user_id),
  UNIQUE (source_product, legacy_login_alias)
);
CREATE INDEX idx_identity_legacy_mapping_center_user ON identity.legacy_account_mappings(center_user_id);
CREATE INDEX idx_identity_legacy_mapping_status ON identity.legacy_account_mappings(source_product, status);
`;
