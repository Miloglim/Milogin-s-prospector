BEGIN;

DROP INDEX IF EXISTS prospector.idx_contacts_email;
CREATE INDEX IF NOT EXISTS idx_contacts_email_lookup ON prospector.contacts(lower(btrim(email)));

ALTER TABLE prospector.crm_customers DROP CONSTRAINT IF EXISTS crm_customers_source_customer_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_customers_scope_key
  ON prospector.crm_customers(source,customer_key,origin,COALESCE(owner_user_id,'00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE IF NOT EXISTS prospector.crm_lead_overlaps (
  overlap_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_contact_id integer NOT NULL REFERENCES prospector.contacts(id),
  target_contact_id integer NOT NULL REFERENCES prospector.contacts(id),
  source_customer_id uuid NOT NULL REFERENCES prospector.crm_customers(customer_id),
  target_customer_id uuid NOT NULL REFERENCES prospector.crm_customers(customer_id),
  match_type text NOT NULL CHECK(match_type IN ('same_email','same_company_country','similar_company')),
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','confirmed','ignored','won')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_contact_id,target_contact_id,match_type),
  CHECK(source_contact_id<>target_contact_id)
);
CREATE INDEX IF NOT EXISTS idx_crm_lead_overlaps_source ON prospector.crm_lead_overlaps(source_contact_id,status);
CREATE INDEX IF NOT EXISTS idx_crm_lead_overlaps_target ON prospector.crm_lead_overlaps(target_contact_id,status);

CREATE TABLE IF NOT EXISTS prospector.crm_deal_overlap_notices (
  notice_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  overlap_id uuid NOT NULL REFERENCES prospector.crm_lead_overlaps(overlap_id),
  winner_contact_id integer NOT NULL REFERENCES prospector.contacts(id),
  recipient_user_id uuid NOT NULL REFERENCES public.identity_users(user_id),
  opportunity_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','acknowledged','stop_requested','collaboration_requested')),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(opportunity_id,recipient_user_id,overlap_id)
);
CREATE INDEX IF NOT EXISTS idx_crm_deal_overlap_notices_recipient ON prospector.crm_deal_overlap_notices(recipient_user_id,status,created_at DESC);

COMMIT;
