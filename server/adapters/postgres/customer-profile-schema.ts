/** B1 is additive: the executed foundation, collaboration and customer migrations stay immutable. */
export const CUSTOMER_PROFILE_VERSION = '011-customer-workbook-profile';
export const CUSTOMER_PROFILE_SQL = `
ALTER TABLE crm_customers ADD COLUMN business_type text;
ALTER TABLE crm_customers ADD COLUMN development_restriction text;
ALTER TABLE crm_customers ADD COLUMN source_created_at timestamptz;
ALTER TABLE contacts ALTER COLUMN email DROP NOT NULL;
ALTER TABLE crm_import_rows DROP CONSTRAINT crm_import_rows_status_check;
ALTER TABLE crm_import_rows ADD CONSTRAINT crm_import_rows_status_check CHECK(status IN ('created','appended','duplicate','invalid','unmatched','ambiguous','restricted_conflict'));
CREATE TABLE crm_workbook_source_mappings (
 actor_id uuid NOT NULL REFERENCES identity.users(user_id), source text NOT NULL,
 origin text NOT NULL CHECK(origin IN ('personal','operations')),
 entity text NOT NULL CHECK(entity IN ('customer','contact')), source_ref text NOT NULL,
 customer_ref text NOT NULL, customer_id uuid NOT NULL REFERENCES crm_customers(customer_id),
 contact_id integer REFERENCES contacts(id), created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((entity='contact')=(contact_id IS NOT NULL)),
 PRIMARY KEY(actor_id,source,origin,entity,source_ref)
);
CREATE INDEX idx_crm_customer_contacts_customer ON crm_customer_contacts(customer_id,contact_id);
CREATE INDEX idx_crm_shared_activities_customer ON crm_shared_activities(customer_id,id DESC);
`;
