import { CAMPAIGN_LIMITS, CAMPAIGN_STATES, CAMPAIGN_TARGET_STATES, CAMPAIGN_ATTEMPT_STATES } from '../../core/campaigns';
export const CAMPAIGN_VERSION='026-server-campaigns-n7';
export const CAMPAIGN_LOCK=19041026;
const quote=(v:string)=>v.split(',').map(x=>`'${x}'`).join(',');
export const CAMPAIGN_SQL=`
CREATE TABLE crm_campaigns(
 campaign_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),created_by uuid NOT NULL REFERENCES identity.users(user_id),name text NOT NULL CHECK(btrim(name)<>'' AND length(name)<=${CAMPAIGN_LIMITS.name}),
 state text NOT NULL DEFAULT 'draft' CHECK(state IN (${quote(CAMPAIGN_STATES.join(','))})),version integer NOT NULL DEFAULT 1 CHECK(version>0),auto_send boolean NOT NULL DEFAULT false CHECK(auto_send=false),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND ${CAMPAIGN_LIMITS.key}),confirmed_at timestamptz,paused_at timestamptz,stopped_at timestamptz,stop_reason text CHECK(stop_reason IS NULL OR length(stop_reason)<=${CAMPAIGN_LIMITS.reason}),next_run_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(created_by,idempotency_key),
 CHECK((state='draft' AND confirmed_at IS NULL) OR (state<>'draft' AND confirmed_at IS NOT NULL)),CHECK((state='paused' AND paused_at IS NOT NULL) OR (state<>'paused' AND paused_at IS NULL))
);
CREATE INDEX idx_crm_campaigns_due ON crm_campaigns(next_run_at,campaign_id) WHERE state IN ('scheduled','running');
CREATE TABLE crm_campaign_targets(
 target_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),campaign_id uuid NOT NULL REFERENCES crm_campaigns(campaign_id) ON DELETE CASCADE,contact_id integer NOT NULL,customer_id uuid NOT NULL REFERENCES crm_customers(customer_id),contact_version integer NOT NULL CHECK(contact_version>0),round integer NOT NULL CHECK(round>=0),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN (${quote(CAMPAIGN_TARGET_STATES.join(','))})),next_touch_at timestamptz,lease_owner text,lease_until timestamptz,attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count>=0),last_error text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(campaign_id,contact_id,round),CHECK((state='leased' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL) OR state<>'leased')
);
CREATE INDEX idx_crm_campaign_targets_due ON crm_campaign_targets(next_touch_at,target_id) WHERE state='pending';
CREATE INDEX idx_crm_campaign_targets_lease ON crm_campaign_targets(lease_until,target_id) WHERE state='leased';
CREATE TABLE crm_campaign_attempts(
 attempt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),target_id uuid NOT NULL REFERENCES crm_campaign_targets(target_id),execution_key text NOT NULL UNIQUE,state text NOT NULL CHECK(state IN (${quote(CAMPAIGN_ATTEMPT_STATES.join(','))})),requested_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,error text
);
CREATE TABLE crm_campaign_receipts(
 receipt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),attempt_id uuid NOT NULL UNIQUE REFERENCES crm_campaign_attempts(attempt_id),state text NOT NULL CHECK(state IN ('accepted','rejected','unknown')),recorded_at timestamptz NOT NULL DEFAULT now(),detail text
);
CREATE INDEX idx_crm_campaign_attempts_target ON crm_campaign_attempts(target_id,requested_at);
`;
