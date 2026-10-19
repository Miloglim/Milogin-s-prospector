export const PASSWORD_COMPAT_SCHEMA_VERSION = "028-legacy-pbkdf2-compat";
export const PASSWORD_COMPAT_SCHEMA_LOCK = 19041028;
export const PASSWORD_COMPAT_SCHEMA_SQL = `
ALTER TABLE identity.credentials DROP CONSTRAINT IF EXISTS credentials_hash_scheme_check;
ALTER TABLE identity.credentials ADD CONSTRAINT credentials_hash_scheme_check
  CHECK (hash_scheme IN ('scrypt-v1','pbkdf2_sha256'));
`;
