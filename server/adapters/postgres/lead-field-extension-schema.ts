/** Additive fields for company classification and contact channels/source attribution. */
export const LEAD_FIELD_EXTENSION_VERSION = '030-lead-field-extension';
export const LEAD_FIELD_EXTENSION_SQL = `
ALTER TABLE companies ADD COLUMN customer_type text CHECK (customer_type IS NULL OR customer_type IN ('代理','直客'));
ALTER TABLE contacts ADD COLUMN whatsapp text;
ALTER TABLE contacts ADD COLUMN source_level1 text;
ALTER TABLE contacts ADD COLUMN source_level2 text;
ALTER TABLE crm_contact_shares DROP CONSTRAINT IF EXISTS crm_contact_shares_editable_fields_check;
ALTER TABLE crm_contact_shares ADD CONSTRAINT crm_contact_shares_editable_fields_check CHECK(jsonb_typeof(editable_fields)='array' AND editable_fields <@ '["firstName","lastName","title","phone","whatsapp","linkedinUrl","country","language","clientType"]'::jsonb);
`;
