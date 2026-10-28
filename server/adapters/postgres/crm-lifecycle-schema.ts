export const LIFECYCLE_VERSION='022-crm-lifecycle-public';
/** Tombstones retain foreign keys, mail evidence and attribution; no legacy schema is rewritten. */
export const LIFECYCLE_SQL=`
ALTER TABLE contacts ADD COLUMN crm_deleted_at timestamptz, ADD COLUMN crm_deleted_by uuid REFERENCES public.identity_users(user_id);
ALTER TABLE companies ADD COLUMN crm_created_by uuid REFERENCES public.identity_users(user_id), ADD COLUMN crm_deleted_at timestamptz, ADD COLUMN crm_deleted_by uuid REFERENCES public.identity_users(user_id);
CREATE INDEX idx_crm_companies_creator ON companies(crm_created_by) WHERE crm_deleted_at IS NULL;
`;
