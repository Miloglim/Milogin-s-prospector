export const CONTACT_SHARING_VERSION='023-contact-sharing';
export const CONTACT_SHARING_SQL=`
CREATE TABLE crm_contact_shares (
 share_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),contact_id integer NOT NULL REFERENCES contacts(id),customer_id uuid NOT NULL REFERENCES crm_customers(customer_id),
 grantor_user_id uuid NOT NULL REFERENCES identity.users(user_id),target_user_id uuid NOT NULL REFERENCES identity.users(user_id),
 editable_fields jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(editable_fields)='array' AND editable_fields <@ '["firstName","lastName","title","phone","linkedinUrl","country","language","clientType"]'::jsonb),can_followup boolean NOT NULL DEFAULT false,can_change_stage boolean NOT NULL DEFAULT false,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected','revoked')),version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),decided_at timestamptz,
 FOREIGN KEY(customer_id,contact_id) REFERENCES crm_customer_contacts(customer_id,contact_id),CHECK(grantor_user_id<>target_user_id)
);
CREATE UNIQUE INDEX idx_contact_share_active ON crm_contact_shares(contact_id,target_user_id) WHERE status IN ('pending','accepted');
CREATE INDEX idx_contact_share_incoming ON crm_contact_shares(target_user_id,status,created_at DESC);
CREATE INDEX idx_contact_share_outgoing ON crm_contact_shares(grantor_user_id,status,created_at DESC);
`;
