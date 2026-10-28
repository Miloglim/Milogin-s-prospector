export const PASSWORD_COMPAT_SCHEMA_VERSION = "028-legacy-pbkdf2-compat-public";
export const PASSWORD_COMPAT_SCHEMA_LOCK = 19041028;
export const PASSWORD_COMPAT_SCHEMA_SQL = `
ALTER TABLE public.identity_credentials DROP CONSTRAINT IF EXISTS identity_credentials_hash_scheme_check;
ALTER TABLE public.identity_credentials ADD CONSTRAINT identity_credentials_hash_scheme_check
  CHECK (hash_scheme IN ('scrypt-v1','pbkdf2_sha256'));
`;
