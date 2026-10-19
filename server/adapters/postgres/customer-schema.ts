/** Immutable R2 migration; existing customer provenance remains operational. */
export const CUSTOMER_VERSION='008-center-customers';
export const CUSTOMER_SQL=`
ALTER TABLE crm_customers ADD COLUMN origin text NOT NULL DEFAULT 'operations' CHECK(origin IN ('operations','personal'));
CREATE INDEX idx_crm_customers_creator_origin ON crm_customers(created_by,origin);
`;
