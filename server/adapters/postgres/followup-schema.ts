import {CRM_STAGES} from '../../core/crm';
import {CONTACT_TOUCH_STATUSES,FOLLOWUP_METHODS} from '../../core/leads';
export const FOLLOWUP_VERSION='012-customer-followup';
const stages=['cold',...CRM_STAGES].map(value=>`'${value}'`).join(',');
const statuses=CONTACT_TOUCH_STATUSES.map(value=>`'${value}'`).join(',');
const methods=['legacy',...FOLLOWUP_METHODS].map(value=>`'${value}'`).join(',');
/** One-time migration: preserve sending columns and record ambiguous legacy evidence. */
export const FOLLOWUP_SQL=`
ALTER TABLE crm_customers ADD COLUMN relationship_stage text NOT NULL DEFAULT 'cold' CHECK(relationship_stage IN (${stages}));
ALTER TABLE crm_customers ADD COLUMN stage_needs_review boolean NOT NULL DEFAULT false;
ALTER TABLE crm_customers ADD COLUMN legacy_stage_snapshot jsonb NOT NULL DEFAULT '[]';
WITH legacy AS (
 SELECT c.customer_id,COALESCE(jsonb_agg(jsonb_build_object('contactId',ct.id,'stage',ct.stage) ORDER BY ct.id) FILTER(WHERE ct.id IS NOT NULL),'[]'::jsonb) AS snapshot,
 count(ct.id)::int AS contacts,count(DISTINCT ct.stage)::int AS variants,
 bool_and(ct.stage IN (${stages})) FILTER(WHERE ct.id IS NOT NULL) AS legal,min(ct.stage) AS uniform_stage
 FROM crm_customers c LEFT JOIN crm_customer_contacts cc ON cc.customer_id=c.customer_id LEFT JOIN contacts ct ON ct.id=cc.contact_id GROUP BY c.customer_id
)
UPDATE crm_customers c SET legacy_stage_snapshot=legacy.snapshot,
 relationship_stage=CASE WHEN legacy.contacts>0 AND legacy.variants=1 AND legacy.legal THEN legacy.uniform_stage ELSE 'cold' END,
 stage_needs_review=legacy.contacts>0 AND NOT COALESCE(legacy.variants=1 AND legacy.legal,false)
FROM legacy WHERE legacy.customer_id=c.customer_id;
ALTER TABLE contacts ADD COLUMN crm_touch_status text NOT NULL DEFAULT 'uncontacted' CHECK(crm_touch_status IN (${statuses}));
ALTER TABLE crm_shared_activities ALTER COLUMN interaction_id DROP NOT NULL;
ALTER TABLE crm_shared_activities ADD COLUMN method text NOT NULL DEFAULT 'legacy' CHECK(method IN (${methods}));
ALTER TABLE crm_shared_activities ADD COLUMN occurred_at timestamptz;
ALTER TABLE crm_shared_activities ADD COLUMN recorded_at timestamptz;
UPDATE crm_shared_activities SET occurred_at=created_at,recorded_at=created_at;
ALTER TABLE crm_shared_activities ALTER COLUMN occurred_at SET NOT NULL;
ALTER TABLE crm_shared_activities ALTER COLUMN occurred_at SET DEFAULT now();
ALTER TABLE crm_shared_activities ALTER COLUMN recorded_at SET NOT NULL;
ALTER TABLE crm_shared_activities ALTER COLUMN recorded_at SET DEFAULT now();
ALTER TABLE crm_shared_activities ADD COLUMN contact_id integer REFERENCES contacts(id);
ALTER TABLE crm_shared_activities ADD COLUMN contact_status text CHECK(contact_status IN (${statuses}));
ALTER TABLE crm_shared_activities ADD CONSTRAINT crm_activity_touch_requires_contact CHECK(contact_status IS NULL OR (contact_id IS NOT NULL AND method NOT IN ('note','legacy')));
CREATE INDEX idx_crm_activities_occurred ON crm_shared_activities(customer_id,occurred_at DESC,id DESC);
`;
