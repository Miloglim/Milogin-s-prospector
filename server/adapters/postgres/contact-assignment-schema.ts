export const CONTACT_ASSIGNMENT_VERSION='019-contact-assignment-acceptance';
export const CONTACT_ASSIGNMENT_SQL=`
ALTER TABLE contacts ADD COLUMN crm_contact_version integer NOT NULL DEFAULT 1 CHECK(crm_contact_version>0);
ALTER TABLE crm_customer_contacts ADD CONSTRAINT crm_customer_contacts_pair UNIQUE(customer_id,contact_id);
CREATE TABLE crm_contact_assignment_requests (
 request_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id integer NOT NULL REFERENCES contacts(id),
 customer_id uuid NOT NULL REFERENCES crm_customers(customer_id), target_user_id uuid NOT NULL REFERENCES identity.users(user_id),
 actor_id uuid NOT NULL REFERENCES identity.users(user_id), notify_user_ids uuid[] NOT NULL DEFAULT '{}',
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected','cancelled')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz,
 FOREIGN KEY(customer_id,contact_id) REFERENCES crm_customer_contacts(customer_id,contact_id)
);
CREATE UNIQUE INDEX idx_crm_contact_active_assignment ON crm_contact_assignment_requests(contact_id) WHERE status IN ('pending','accepted');
CREATE INDEX idx_crm_contact_assignment_target ON crm_contact_assignment_requests(target_user_id,status,created_at DESC);
CREATE INDEX idx_crm_contact_assignment_actor ON crm_contact_assignment_requests(actor_id,status,created_at DESC);
`;
