BEGIN;

CREATE TABLE IF NOT EXISTS public.identity_device_handoffs (
  handoff_id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  request_key text NOT NULL,
  user_id uuid NOT NULL REFERENCES public.identity_users(user_id),
  desktop_product text NOT NULL,
  old_session_id uuid NOT NULL REFERENCES public.identity_sessions(session_id),
  old_device_id text,
  old_device_name text,
  new_device_id text NOT NULL,
  new_device_name text NOT NULL,
  new_platform text NOT NULL,
  new_app_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('waiting_old_device','ready','blocked','completed','cancelled','expired')),
  summary jsonb CHECK (summary IS NULL OR jsonb_typeof(summary)='object'),
  takeover_reason text,
  prepared_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,desktop_product,request_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_device_handoffs_pending
  ON public.identity_device_handoffs(user_id,desktop_product)
  WHERE status IN ('waiting_old_device','ready','blocked');

CREATE INDEX IF NOT EXISTS idx_identity_device_handoffs_token
  ON public.identity_device_handoffs(token_hash,status,expires_at);

CREATE INDEX IF NOT EXISTS idx_identity_device_handoffs_session
  ON public.identity_device_handoffs(old_session_id,status);

ALTER TABLE public.identity_audit DROP CONSTRAINT IF EXISTS identity_audit_event_check;
ALTER TABLE public.identity_audit ADD CONSTRAINT identity_audit_event_check CHECK (event IN (
  'login','logout','fixture','device.handoff.begin','device.handoff.ready','device.handoff.blocked',
  'device.handoff.completed','device.handoff.takeover','device.handoff.cancelled'
));

COMMIT;
