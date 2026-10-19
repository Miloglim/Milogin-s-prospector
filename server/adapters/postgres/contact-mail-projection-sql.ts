/** A correction supersedes only facts for the same actor, mailbox and original message. */
export function effectiveMailFactSql(alias = 'mf'): string {
  return `NOT ${alias}.archive_only AND NOT EXISTS(
    SELECT 1 FROM crm_contact_mail_events mc
    WHERE mc.actor_id=${alias}.actor_id AND mc.mailbox_key=${alias}.mailbox_key
      AND mc.message_key=${alias}.message_key AND mc.contact_id=${alias}.contact_id
      AND mc.customer_id=${alias}.customer_id AND mc.classification_revision IS NOT NULL
      AND mc.classification_revision>COALESCE(${alias}.classification_revision,0)
  )`;
}

export function effectiveActivitySql(alias = 'act'): string {
  return `NOT EXISTS(
    SELECT 1 FROM crm_contact_mail_events mf
    WHERE mf.activity_id=${alias}.id AND NOT (${effectiveMailFactSql('mf')})
  )`;
}
/** Current last-contact display combines independent manual activities with effective mail facts. */
export function lastEffectiveFollowupSql(field: 'occurred_at' | 'note'): string {
  const validMail = `(
    mf.kind='replied' AND mf.direction='inbound' AND lower(mf.from_email)=lower(ct.email)
      AND jsonb_array_length(mf.to_emails)>0
    OR mf.kind='sent' AND mf.direction='outbound' AND mf.to_emails ? lower(ct.email)
      AND lower(mf.from_email)<>lower(ct.email)
  )`;
  return `(SELECT current_followup.${field} FROM (
    SELECT act.occurred_at,act.note,act.recorded_at,TRUE AS manual,act.id::text AS fact_id
    FROM crm_shared_activities act
    WHERE act.contact_id=ct.id AND act.customer_id=c.customer_id AND act.opportunity_id IS NULL
      AND act.method IN ('email','phone','visit','other')
      AND NOT EXISTS(SELECT 1 FROM crm_contact_mail_events ma WHERE ma.activity_id=act.id)
    UNION ALL
    SELECT mf.occurred_at,COALESCE(NULLIF(mf.subject,''),mf.preview) AS note,
      mf.recorded_at,FALSE AS manual,mf.event_id::text AS fact_id
    FROM crm_contact_mail_events mf
    WHERE mf.contact_id=ct.id AND mf.customer_id=c.customer_id
      AND ${validMail} AND ${effectiveMailFactSql()}
  ) current_followup
  ORDER BY occurred_at DESC,manual DESC,recorded_at DESC,fact_id DESC LIMIT 1)`;
}
