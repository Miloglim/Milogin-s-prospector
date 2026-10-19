export const PASSWORD_SCHEMA_VERSION='004-mandatory-password-change';
export const PASSWORD_SCHEMA_LOCK=19041004;
export const PASSWORD_SCHEMA_SQL=`ALTER TABLE identity.users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;`;
