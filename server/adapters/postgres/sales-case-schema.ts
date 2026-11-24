export const SALES_CASE_SCHEMA_VERSION = '080-ai-sales-workflow-foundation';
export const SALES_WORKFLOW_INTEGRITY_VERSION = '082-ai-sales-workflow-integrity';

export const SALES_WORKFLOW_INTEGRITY_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS uq_quote_cases_case_message ON crm_quote_cases(case_id,message_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_quote_drafts_case ON crm_quote_drafts(quote_case_id);
CREATE INDEX IF NOT EXISTS idx_case_events_type ON crm_case_events(case_id,event_type,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quote_revisions_quote ON crm_quote_revisions(quote_id,version DESC);
`;
export const SALES_CASE_PROPOSAL_SCHEMA_VERSION = '081-deal-won-proposals';

export const SALES_CASE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS crm_sales_cases (
  case_id text PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES crm_customers(customer_id) ON DELETE CASCADE,
  contact_id bigint NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES public.identity_users(user_id),
  state text NOT NULL CHECK(state IN ('lead_pending','lead_verified','outreach_ready','outreach_running','awaiting_reply','replied','inquiry_detected','quote_preparing','quote_review','quote_sent','negotiating','won','lost','paused')),
  source text NOT NULL,
  verified_at timestamptz,
  latest_message_key text,
  latest_summary text,
  next_action text,
  next_action_at timestamptz,
  stop_reason text,
  version integer NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_sales_cases_owner_state ON crm_sales_cases(owner_user_id,state,next_action_at);
CREATE INDEX IF NOT EXISTS idx_sales_cases_customer ON crm_sales_cases(customer_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_cases_contact ON crm_sales_cases(contact_id,updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_cases_one_open_contact_owner
  ON crm_sales_cases(contact_id,owner_user_id)
  WHERE state NOT IN ('won','lost');

CREATE TABLE IF NOT EXISTS crm_case_events (
  event_id bigserial PRIMARY KEY,
  case_id text NOT NULL REFERENCES crm_sales_cases(case_id) ON DELETE CASCADE,
  event_key text NOT NULL UNIQUE,
  event_type text NOT NULL,
  source text NOT NULL CHECK(source IN ('rule','ai','user','system')),
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  actor_user_id uuid REFERENCES public.identity_users(user_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_case_events_case ON crm_case_events(case_id,created_at DESC);

CREATE TABLE IF NOT EXISTS crm_ai_proposals (
  proposal_id text PRIMARY KEY,
  case_id text NOT NULL REFERENCES crm_sales_cases(case_id) ON DELETE CASCADE,
  proposal_type text NOT NULL CHECK(proposal_type IN ('campaign_draft','reply_draft','quote_draft','followup')),
  status text NOT NULL CHECK(status IN ('pending','accepted','edited','ignored','expired','blocked')),
  payload_json jsonb NOT NULL,
  evidence_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence double precision NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  model text,
  version text,
  expires_at timestamptz,
  acted_by uuid REFERENCES public.identity_users(user_id),
  acted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_ai_proposals_case ON crm_ai_proposals(case_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_proposals_pending ON crm_ai_proposals(status,expires_at);

CREATE TABLE IF NOT EXISTS crm_quote_cases (
  quote_case_id text PRIMARY KEY,
  case_id text NOT NULL REFERENCES crm_sales_cases(case_id) ON DELETE CASCADE,
  message_key text NOT NULL,
  thread_key text NOT NULL,
  state text NOT NULL,
  fields_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  missing_fields_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  selected_quote_json jsonb,
  version integer NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_quote_cases_case ON crm_quote_cases(case_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_quote_cases_thread ON crm_quote_cases(thread_key,updated_at DESC);

CREATE TABLE IF NOT EXISTS crm_quote_drafts (
  quote_id text PRIMARY KEY,
  quote_case_id text NOT NULL REFERENCES crm_quote_cases(quote_case_id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1 CHECK(version > 0),
  status text NOT NULL,
  subject text,
  body text,
  selected_candidate_json jsonb,
  candidates_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_quote_drafts_case ON crm_quote_drafts(quote_case_id,updated_at DESC);

CREATE TABLE IF NOT EXISTS crm_quote_revisions (
  revision_id text PRIMARY KEY,
  quote_id text NOT NULL REFERENCES crm_quote_drafts(quote_id) ON DELETE CASCADE,
  version integer NOT NULL,
  status text NOT NULL,
  fields_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  selected_candidate_json jsonb,
  candidates_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  subject text,
  body text,
  actor_user_id uuid NOT NULL REFERENCES public.identity_users(user_id),
  reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(quote_id,version)
);

CREATE TABLE IF NOT EXISTS crm_quote_review_requests (
  review_id text PRIMARY KEY,
  quote_id text NOT NULL REFERENCES crm_quote_drafts(quote_id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES public.identity_users(user_id),
  reviewer_user_id uuid NOT NULL REFERENCES public.identity_users(user_id),
  status text NOT NULL CHECK(status IN ('pending','approved','rejected','cancelled')),
  reason text,
  decision_note text,
  linked_message_id text,
  linked_task_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_quote_reviews_reviewer ON crm_quote_review_requests(reviewer_user_id,status,created_at DESC);

CREATE TABLE IF NOT EXISTS crm_ai_feedback_events (
  feedback_id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.identity_users(user_id),
  object_type text NOT NULL,
  object_id text NOT NULL,
  action text NOT NULL,
  before_json jsonb,
  after_json jsonb,
  reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_ai_feedback_user ON crm_ai_feedback_events(user_id,created_at DESC);
`;

export const SALES_CASE_PROPOSAL_SCHEMA_SQL = `
ALTER TABLE crm_ai_proposals DROP CONSTRAINT IF EXISTS crm_ai_proposals_proposal_type_check;
ALTER TABLE crm_ai_proposals ADD CONSTRAINT crm_ai_proposals_proposal_type_check
  CHECK(proposal_type IN ('campaign_draft','reply_draft','quote_draft','followup','deal_won'));
ALTER TABLE crm_ai_proposals DROP CONSTRAINT IF EXISTS crm_ai_proposals_status_check;
ALTER TABLE crm_ai_proposals ADD CONSTRAINT crm_ai_proposals_status_check
  CHECK(status IN ('pending','applied_pending_confirmation','accepted','edited','ignored','cancelled','expired','blocked'));
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_deal_won_active_case
  ON crm_ai_proposals(case_id)
  WHERE proposal_type='deal_won' AND status='applied_pending_confirmation';
`;
