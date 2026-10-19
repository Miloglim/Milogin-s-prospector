import { TASK_LIMITS } from '../../core/tasks';
export const TASK_VERSION='017-followup-tasks';
export const TASK_LOCK=19041017;
export const TASK_SQL=`
CREATE TABLE crm_followup_tasks (
 task_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),customer_id uuid NOT NULL REFERENCES crm_customers(customer_id),
 title text NOT NULL CHECK(btrim(title)<>'' AND length(title)<=${TASK_LIMITS.title}),due_at timestamptz NOT NULL CHECK(isfinite(due_at)),
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','completed')),version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_by uuid NOT NULL REFERENCES identity.users(user_id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,completed_by uuid REFERENCES identity.users(user_id),feedback text,
 CHECK((status='open' AND completed_at IS NULL AND completed_by IS NULL AND feedback IS NULL) OR (status='completed' AND completed_at IS NOT NULL AND completed_by IS NOT NULL AND feedback IS NOT NULL AND btrim(feedback)<>'' AND length(feedback)<=${TASK_LIMITS.feedback}))
);
CREATE INDEX idx_crm_tasks_customer ON crm_followup_tasks(customer_id,due_at,task_id);
CREATE INDEX idx_crm_tasks_due ON crm_followup_tasks(due_at,task_id) WHERE status='open';
CREATE TABLE crm_task_due_receipts (
 task_id uuid NOT NULL REFERENCES crm_followup_tasks(task_id),task_version integer NOT NULL CHECK(task_version>0),
 responsible_user_id uuid NOT NULL REFERENCES identity.users(user_id),event_id uuid NOT NULL UNIQUE REFERENCES identity.outbox(event_id),
 PRIMARY KEY(task_id,task_version)
);
CREATE FUNCTION crm_tasks_customer_owner_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id THEN
  UPDATE crm_followup_tasks SET version=version+1,updated_at=clock_timestamp() WHERE customer_id=NEW.customer_id AND status='open';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_tasks_customer_owner_changed AFTER UPDATE OF owner_user_id ON crm_customers FOR EACH ROW EXECUTE FUNCTION crm_tasks_customer_owner_changed();
`;
