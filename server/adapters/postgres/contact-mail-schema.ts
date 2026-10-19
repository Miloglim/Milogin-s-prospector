import { CONTACT_MAIL_KINDS, CONTACT_MAIL_LIMITS as L } from '../../core/contact-mail';
export const CONTACT_MAIL_VERSION = '020-contact-mail-events';
export const CONTACT_MAIL_SEND_STAGE_VERSION = '021-contact-mail-send-stage';
export const CONTACT_MAIL_SEND_STAGE_SQL = 'ALTER TABLE crm_contact_mail_events ADD COLUMN send_stage_advanced boolean NOT NULL DEFAULT false;';
export const CONTACT_MAIL_SQL = `
CREATE TABLE crm_contact_mail_events (
 event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid NOT NULL REFERENCES identity.users(user_id),
 contact_id integer NOT NULL REFERENCES contacts(id), customer_id uuid NOT NULL REFERENCES crm_customers(customer_id),
 event_key text NOT NULL CHECK(length(event_key) BETWEEN 1 AND ${L.key}),
 mailbox_key text NOT NULL CHECK(length(mailbox_key) BETWEEN 1 AND ${L.mailboxKey}),
 message_key text NOT NULL CHECK(length(message_key) BETWEEN 1 AND ${L.key}),
 kind text NOT NULL CHECK(kind IN (${CONTACT_MAIL_KINDS.map(kind => `'${kind}'`).join(',')})),
 direction text NOT NULL CHECK(direction IN ('inbound','outbound')), occurred_at timestamptz NOT NULL,
 subject text NOT NULL CHECK(length(subject)<=${L.subject}), preview text NOT NULL CHECK(length(preview)<=${L.preview}),
 from_email text NOT NULL CHECK(length(from_email) BETWEEN 1 AND ${L.email}),
 to_emails jsonb NOT NULL CHECK(jsonb_typeof(to_emails)='array' AND jsonb_array_length(to_emails)<=${L.recipients}),
 cc_emails jsonb NOT NULL CHECK(jsonb_typeof(cc_emails)='array' AND jsonb_array_length(cc_emails)<=${L.recipients}),
 digest text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(), activity_id bigint REFERENCES crm_shared_activities(id),
 UNIQUE(actor_id,event_key), FOREIGN KEY(customer_id,contact_id) REFERENCES crm_customer_contacts(customer_id,contact_id)
);
CREATE INDEX idx_crm_contact_mail_history ON crm_contact_mail_events(customer_id,contact_id,occurred_at DESC,event_id DESC);
`;
