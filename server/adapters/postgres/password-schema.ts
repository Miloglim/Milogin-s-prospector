export const PASSWORD_SCHEMA_VERSION='004-mandatory-password-change-public';
export const PASSWORD_SCHEMA_LOCK=19041004;
export const PASSWORD_SCHEMA_SQL=`ALTER TABLE public.identity_users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;`;
