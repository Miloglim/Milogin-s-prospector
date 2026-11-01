export const DESKTOP_DEVICE_SCHEMA_VERSION = '008-desktop-active-device-public';
export const DESKTOP_DEVICE_SCHEMA_LOCK = 19041008;
export const DESKTOP_DEVICE_SCHEMA_SQL = `
ALTER TABLE public.identity_sessions ADD COLUMN IF NOT EXISTS desktop_product text;
ALTER TABLE public.identity_sessions ADD COLUMN IF NOT EXISTS desktop_device_id text;
ALTER TABLE public.identity_sessions ADD COLUMN IF NOT EXISTS desktop_device_name text;
ALTER TABLE public.identity_sessions ADD COLUMN IF NOT EXISTS desktop_platform text;
ALTER TABLE public.identity_sessions ADD COLUMN IF NOT EXISTS desktop_app_version text;
ALTER TABLE public.identity_sessions ADD COLUMN IF NOT EXISTS revocation_reason text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_sessions_active_desktop_product
  ON public.identity_sessions(user_id,desktop_product)
  WHERE desktop_product IS NOT NULL AND revoked_at IS NULL;
`;
