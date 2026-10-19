export const NOTIFICATION_VERSION='006-notification-m2';
export const NOTIFICATION_LOCK=19041006;
export const NOTIFICATION_SQL=`
ALTER TABLE identity.outbox ADD COLUMN payload jsonb NOT NULL DEFAULT '{}';
CREATE TABLE crm_notification_consumed(event_id uuid PRIMARY KEY REFERENCES identity.outbox(event_id),consumed_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE crm_feed_heads(user_id uuid PRIMARY KEY REFERENCES identity.users(user_id),delivery_seq bigint NOT NULL DEFAULT 0 CHECK(delivery_seq>=0));
CREATE TABLE crm_event_deliveries(
 delivery_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event_id uuid NOT NULL REFERENCES identity.outbox(event_id),
 recipient_user_id uuid NOT NULL REFERENCES identity.users(user_id),projection_type text NOT NULL CHECK(projection_type='lead'),
 delivery_seq bigint NOT NULL CHECK(delivery_seq>0),customer_id uuid NOT NULL REFERENCES crm_customers(customer_id),
 event_type text NOT NULL,version integer NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(event_id,recipient_user_id,projection_type),UNIQUE(recipient_user_id,delivery_seq));
CREATE TABLE crm_device_cursors(user_id uuid NOT NULL REFERENCES identity.users(user_id),device_id text NOT NULL,cursor bigint NOT NULL DEFAULT 0,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,device_id));
CREATE TABLE crm_notification_reads(user_id uuid NOT NULL REFERENCES identity.users(user_id),delivery_id uuid NOT NULL REFERENCES crm_event_deliveries(delivery_id),read_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,delivery_id));
`;
