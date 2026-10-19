export const MAIL_CORRECTION_VERSION = '024-mail-classification-correction';
export const MAIL_CORRECTION_SQL = `
ALTER TABLE crm_contact_mail_events ADD COLUMN classification_correction jsonb;
ALTER TABLE crm_contact_mail_events ADD COLUMN classification_revision integer;
ALTER TABLE crm_contact_mail_events ADD CONSTRAINT crm_mail_correction_shape CHECK (
  (classification_correction IS NULL AND classification_revision IS NULL)
  OR (
    classification_correction IS NOT NULL AND classification_revision IS NOT NULL
    AND classification_revision>0 AND direction='inbound' AND NOT send_stage_advanced
    AND jsonb_typeof(classification_correction)='object'
    AND classification_correction ?& ARRAY['previousEventKey','classification']
    AND (classification_correction-'previousEventKey'-'classification')='{}'::jsonb
    AND jsonb_typeof(classification_correction->'classification')='string'
    AND classification_correction->>'classification' IN ('other','replied','autoreply','bounced')
    AND kind=CASE classification_correction->>'classification'
      WHEN 'other' THEN 'received' ELSE classification_correction->>'classification' END
    AND (
      classification_correction->'previousEventKey'='null'::jsonb
      OR jsonb_typeof(classification_correction->'previousEventKey')='string'
    )
  )
);
CREATE UNIQUE INDEX idx_mail_correction_revision ON crm_contact_mail_events(
  actor_id,mailbox_key,message_key,contact_id,customer_id,classification_revision
) WHERE classification_revision IS NOT NULL;
CREATE INDEX idx_mail_activity_projection ON crm_contact_mail_events(activity_id)
  WHERE activity_id IS NOT NULL;
CREATE INDEX idx_mail_message_stream ON crm_contact_mail_events(
  actor_id,mailbox_key,message_key,contact_id,customer_id
);
`;
