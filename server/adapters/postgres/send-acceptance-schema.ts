import { SEND_AUTHORIZATION_LIMITS } from '../../core/send-acceptance';
export const SEND_ACCEPTANCE_VERSION = '025-send-acceptance';
export const SEND_ACCEPTANCE_SQL = `
ALTER TABLE crm_contact_mail_events ADD COLUMN archive_only boolean NOT NULL DEFAULT false;
CREATE TABLE crm_send_authorizations (
  authorization_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL REFERENCES identity.users(user_id),
  send_key text NOT NULL CHECK(length(send_key) BETWEEN 1 AND ${SEND_AUTHORIZATION_LIMITS.sendKey}),
  contact_id integer NOT NULL REFERENCES contacts(id),
  customer_id uuid NOT NULL REFERENCES crm_customers(customer_id),
  recipient_email text NOT NULL, from_email text NOT NULL, subject text NOT NULL,
  authorized_recipients jsonb NOT NULL CHECK(jsonb_typeof(authorized_recipients)='array'),
  authorized_cc jsonb NOT NULL CHECK(jsonb_typeof(authorized_cc)='array'),
  request_fingerprint text NOT NULL,
  owner_user_id uuid REFERENCES identity.users(user_id),
  allow_advance_stage boolean NOT NULL,
  issued_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  consumed_event_id uuid UNIQUE REFERENCES crm_contact_mail_events(event_id),
  consumed_fingerprint text, archived_after_revocation boolean,
  CHECK(expires_at>issued_at),
  CHECK((consumed_event_id IS NULL AND consumed_fingerprint IS NULL AND archived_after_revocation IS NULL)
    OR (consumed_event_id IS NOT NULL AND consumed_fingerprint IS NOT NULL AND archived_after_revocation IS NOT NULL)),
  UNIQUE(actor_id,send_key,contact_id,customer_id),
  FOREIGN KEY(customer_id,contact_id) REFERENCES crm_customer_contacts(customer_id,contact_id)
);
`;
