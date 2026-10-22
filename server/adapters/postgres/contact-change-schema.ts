export const CONTACT_CHANGE_VERSION = '008-contact-change-import-capture';
export const CONTACT_CHANGE_LOCK = 19041007;
export const CONTACT_CHANGE_SQL = `
CREATE SEQUENCE IF NOT EXISTS crm_contact_change_seq AS bigint;
CREATE TABLE IF NOT EXISTS crm_contact_changes (
 change_seq bigint PRIMARY KEY DEFAULT nextval('crm_contact_change_seq'), event_id uuid NOT NULL REFERENCES identity.outbox(event_id),
 recipient_user_id uuid NOT NULL REFERENCES identity.users(user_id), contact_id integer NOT NULL, customer_id uuid NOT NULL REFERENCES crm_customers(customer_id),
 event_type text NOT NULL, version integer NOT NULL CHECK(version>0), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(event_id,recipient_user_id,contact_id)
);
CREATE INDEX IF NOT EXISTS idx_crm_contact_changes_user_seq ON crm_contact_changes(recipient_user_id,change_seq);
CREATE OR REPLACE FUNCTION crm_contact_change_capture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.product_id='crm' AND NEW.customer_id IS NOT NULL AND (
   NEW.event_type = ANY(ARRAY[
     'crm.contact.updated','crm.contact.followup','crm.contact.deleted',
     'crm.contact.assignment.requested','crm.contact.assignment.accepted',
     'crm.contact.assignment.rejected','crm.contact.assignment.cancelled',
     'crm.contact.share.accepted','crm.contact.share.revoked','crm.contact.share.updated'
   ]) OR NEW.event_type = ANY(ARRAY['crm.customer.created','crm.customer.updated'])
 ) THEN
  INSERT INTO crm_contact_changes(event_id,recipient_user_id,contact_id,customer_id,event_type,version)
  SELECT NEW.event_id,u.user_id,ct.id,NEW.customer_id,NEW.event_type,COALESCE(NEW.revision,1)
  FROM crm_customer_contacts cc JOIN contacts ct ON ct.id=cc.contact_id CROSS JOIN identity.users u
  LEFT JOIN identity.product_access pa ON pa.user_id=u.user_id AND pa.product_id='crm' AND pa.active
  LEFT JOIN identity.product_grants g ON g.user_id=u.user_id AND g.product_id='crm' AND g.active AND g.role='admin'
  WHERE cc.customer_id=NEW.customer_id
    AND ((NEW.event_type = ANY(ARRAY['crm.customer.created','crm.customer.updated'])) OR ((NEW.payload->>'contactId') ~ '^[0-9]+$' AND ct.id=(NEW.payload->>'contactId')::integer))
    AND u.active AND NOT u.must_change_password AND pa.user_id IS NOT NULL
    AND (u.user_id=NEW.user_id OR u.user_id=ANY(COALESCE(NEW.recipient_user_ids,'{}'::uuid[])) OR (g.user_id IS NOT NULL AND pa.scope IN ('shared','summary') AND (u.identity_admin OR pa.capabilities IS NULL OR pa.capabilities ? 'leads.read.all')))
  ON CONFLICT(event_id,recipient_user_id,contact_id) DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS crm_contact_change_capture ON identity.outbox;
CREATE TRIGGER crm_contact_change_capture AFTER INSERT ON identity.outbox FOR EACH ROW EXECUTE FUNCTION crm_contact_change_capture();
`;
