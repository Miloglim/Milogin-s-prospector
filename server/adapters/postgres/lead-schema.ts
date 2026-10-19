export const LEAD_VERSION='005-lead-collaboration';
export const LEAD_LOCK=19041005;
export const LEAD_SQL=`
CREATE TABLE crm_customers (
 customer_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id integer NOT NULL REFERENCES companies(id),
 source text NOT NULL,customer_key text NOT NULL,source_detail text NOT NULL,
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','published','owned','paused')),
 owner_user_id uuid REFERENCES identity.users(user_id),created_by uuid NOT NULL REFERENCES identity.users(user_id),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(source,customer_key),CHECK((state='owned')=(owner_user_id IS NOT NULL))
);
CREATE TABLE crm_customer_contacts(customer_id uuid NOT NULL REFERENCES crm_customers(customer_id),contact_id integer PRIMARY KEY REFERENCES contacts(id));
CREATE TABLE crm_import_batches(batch_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),actor_id uuid NOT NULL REFERENCES identity.users(user_id),source text NOT NULL,source_detail text NOT NULL,mapping jsonb NOT NULL DEFAULT '{}',version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE crm_import_rows(row_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),batch_id uuid NOT NULL REFERENCES crm_import_batches(batch_id),row_index integer NOT NULL,customer_key text NOT NULL,raw_row jsonb NOT NULL,customer_id uuid REFERENCES crm_customers(customer_id),status text NOT NULL CHECK(status IN ('created','duplicate','invalid','restricted_conflict')),UNIQUE(batch_id,row_index));
CREATE TABLE crm_assignment_history(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,customer_id uuid NOT NULL REFERENCES crm_customers(customer_id),owner_user_id uuid NOT NULL REFERENCES identity.users(user_id),actor_id uuid NOT NULL REFERENCES identity.users(user_id),created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE crm_shared_activities(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,customer_id uuid NOT NULL REFERENCES crm_customers(customer_id),interaction_id integer NOT NULL REFERENCES interactions(id),actor_id uuid NOT NULL REFERENCES identity.users(user_id),note text NOT NULL,stage text,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE crm_lead_idempotency(actor_id uuid NOT NULL REFERENCES identity.users(user_id),operation text NOT NULL,key text NOT NULL,digest text NOT NULL,response jsonb NOT NULL,PRIMARY KEY(actor_id,operation,key));
ALTER TABLE identity.outbox ADD COLUMN customer_id uuid REFERENCES crm_customers(customer_id);
CREATE INDEX idx_crm_customers_owner ON crm_customers(owner_user_id,state);
`;
