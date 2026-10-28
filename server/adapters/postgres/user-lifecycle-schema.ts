/** Additive migration; historic migrations and their checksums stay immutable. */
export const USER_LIFECYCLE_VERSION='015-user-lifecycle-public';
export const USER_LIFECYCLE_SQL=`
ALTER TABLE public.identity_users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.identity_users DROP CONSTRAINT IF EXISTS deleted_user_inactive;
ALTER TABLE public.identity_users ADD CONSTRAINT deleted_user_inactive CHECK(deleted_at IS NULL OR NOT active);
`;
