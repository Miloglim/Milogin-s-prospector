import { OPPORTUNITY_LIMITS,OPPORTUNITY_STAGES } from '../../core/opportunities';
export const OPPORTUNITY_VERSION='018-opportunities';
export const OPPORTUNITY_LOCK=19041018;
const STAGES=OPPORTUNITY_STAGES.map(s=>`'${s}'`).join(',');
const MONEY=`CHECK((amount IS NULL AND currency IS NULL) OR (amount IS NOT NULL AND currency IS NOT NULL AND amount>=0 AND amount<power(10::numeric,${OPPORTUNITY_LIMITS.amountWholeDigits}) AND scale(amount)<=${OPPORTUNITY_LIMITS.amountFractionDigits} AND currency ~ '^[A-Z]{3}$'))`;
export const OPPORTUNITY_SQL=`
CREATE TABLE crm_opportunities (
 opportunity_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),customer_id uuid NOT NULL REFERENCES crm_customers(customer_id),
 title text NOT NULL CHECK(btrim(title)<>'' AND length(title)<=${OPPORTUNITY_LIMITS.title}),
 description text NOT NULL DEFAULT '' CHECK(length(description)<=${OPPORTUNITY_LIMITS.description}),
 pol text CHECK(length(pol)<=${OPPORTUNITY_LIMITS.route}),pod text CHECK(length(pod)<=${OPPORTUNITY_LIMITS.route}),container_type text CHECK(length(container_type)<=${OPPORTUNITY_LIMITS.route}),
 source text NOT NULL DEFAULT '' CHECK(length(source)<=${OPPORTUNITY_LIMITS.source}),
 stage text NOT NULL DEFAULT 'inquiry' CHECK(stage IN (${STAGES})),amount numeric,currency text,${MONEY},
 lost_reason text CHECK(btrim(lost_reason)<>'' AND length(lost_reason)<=${OPPORTUNITY_LIMITS.reason}),evidence text CHECK(btrim(evidence)<>'' AND length(evidence)<=${OPPORTUNITY_LIMITS.evidence}),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),created_by uuid NOT NULL REFERENCES identity.users(user_id),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),closed_at timestamptz,closed_by uuid REFERENCES identity.users(user_id),
 UNIQUE(opportunity_id,customer_id),
 CHECK((stage IN ('closed_won','closed_lost') AND closed_at IS NOT NULL AND closed_by IS NOT NULL) OR (stage NOT IN ('closed_won','closed_lost') AND closed_at IS NULL AND closed_by IS NULL)),
 CHECK((stage='closed_won' AND evidence IS NOT NULL AND amount IS NOT NULL AND lost_reason IS NULL) OR (stage='closed_lost' AND lost_reason IS NOT NULL AND evidence IS NULL) OR (stage NOT IN ('closed_won','closed_lost') AND evidence IS NULL AND lost_reason IS NULL))
);
CREATE INDEX idx_crm_opportunities_customer ON crm_opportunities(customer_id,created_at,opportunity_id);
CREATE TABLE crm_opportunity_stage_history (
 history_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),opportunity_id uuid NOT NULL REFERENCES crm_opportunities(opportunity_id),
 from_stage text CHECK(from_stage IN (${STAGES})),to_stage text NOT NULL CHECK(to_stage IN (${STAGES})),
 actor_id uuid NOT NULL REFERENCES identity.users(user_id),occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 amount numeric,currency text,${MONEY},lost_reason text,evidence text,
 CHECK(from_stage IS DISTINCT FROM to_stage),
 CHECK((to_stage='closed_won' AND evidence IS NOT NULL AND btrim(evidence)<>'' AND length(evidence)<=${OPPORTUNITY_LIMITS.evidence} AND amount IS NOT NULL AND lost_reason IS NULL) OR (to_stage='closed_lost' AND lost_reason IS NOT NULL AND btrim(lost_reason)<>'' AND length(lost_reason)<=${OPPORTUNITY_LIMITS.reason} AND evidence IS NULL) OR (to_stage NOT IN ('closed_won','closed_lost') AND evidence IS NULL AND lost_reason IS NULL))
);
CREATE INDEX idx_crm_opportunity_history ON crm_opportunity_stage_history(opportunity_id,occurred_at,history_id);
CREATE FUNCTION crm_opportunity_history_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Opportunity stage history is append only' USING ERRCODE='23514'; END $$;
CREATE TRIGGER crm_opportunity_history_append_only BEFORE UPDATE OR DELETE ON crm_opportunity_stage_history FOR EACH ROW EXECUTE FUNCTION crm_opportunity_history_append_only();
CREATE FUNCTION crm_opportunities_customer_owner_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id THEN
  UPDATE crm_opportunities SET version=version+1,updated_at=clock_timestamp() WHERE customer_id=NEW.customer_id AND stage NOT IN ('closed_won','closed_lost');
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_opportunities_customer_owner_changed AFTER UPDATE OF owner_user_id ON crm_customers FOR EACH ROW EXECUTE FUNCTION crm_opportunities_customer_owner_changed();
ALTER TABLE crm_shared_activities ADD COLUMN opportunity_id uuid;
ALTER TABLE crm_shared_activities ADD CONSTRAINT crm_activity_opportunity_customer_fk FOREIGN KEY(opportunity_id,customer_id) REFERENCES crm_opportunities(opportunity_id,customer_id);
CREATE INDEX idx_crm_activity_opportunity ON crm_shared_activities(opportunity_id) WHERE opportunity_id IS NOT NULL;
ALTER TABLE crm_followup_tasks ADD COLUMN opportunity_id uuid;
ALTER TABLE crm_followup_tasks ADD CONSTRAINT crm_task_opportunity_customer_fk FOREIGN KEY(opportunity_id,customer_id) REFERENCES crm_opportunities(opportunity_id,customer_id);
CREATE INDEX idx_crm_task_opportunity ON crm_followup_tasks(opportunity_id) WHERE opportunity_id IS NOT NULL;
`;
