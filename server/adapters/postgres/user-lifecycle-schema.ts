/** Additive migration; historic migrations and their checksums stay immutable. */
export const USER_LIFECYCLE_VERSION='015-user-lifecycle';
export const USER_LIFECYCLE_SQL=`
ALTER TABLE identity.users ADD COLUMN deleted_at timestamptz;
ALTER TABLE identity.users ADD CONSTRAINT deleted_user_inactive CHECK(deleted_at IS NULL OR NOT active);
`;
