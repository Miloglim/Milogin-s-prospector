import type { PoolClient } from 'pg';
import { failure, success, type Result } from '../../core/crm';
import { projectContactMail } from '../../core/contact-mail-projection';
import type { ContactMailEventInput } from '../../core/contact-mail';
import { effectiveMailFactSql } from './contact-mail-projection-sql';

export async function correctionRevisionIn(
  client: PoolClient,
  actorId: string,
  input: ContactMailEventInput,
): Promise<Result<number | null>> {
  if (!input.correction) return success(null);
  const correction = input.correction;
  const kind = correction.classification === 'other' ? 'received' : correction.classification;
  if (input.direction !== 'inbound' || input.advanceSendStage !== undefined || input.kind !== kind) {
    return failure('INVALID_INPUT', '分类更正仅允许收件事实');
  }
  const params = [actorId, input.mailboxKey, input.messageKey, input.contactId, input.customerId];
  const stream = 'actor_id=$1 AND mailbox_key=$2 AND message_key=$3 AND contact_id=$4 AND customer_id=$5';
  const head = (await client.query(`
    SELECT event_key,classification_revision,occurred_at,from_email,to_emails,cc_emails
    FROM crm_contact_mail_events WHERE ${stream} AND classification_revision IS NOT NULL
    ORDER BY classification_revision DESC LIMIT 1`, params)).rows[0];
  if ((head?.event_key ?? null) !== correction.previousEventKey) {
    return failure('CONFLICT', '邮件分类已变化，请刷新后重试');
  }
  const original = head ?? (await client.query(`
    SELECT occurred_at,from_email,to_emails,cc_emails FROM crm_contact_mail_events
    WHERE ${stream} AND direction='inbound' ORDER BY recorded_at,event_id LIMIT 1`, params)).rows[0];
  // A first correction may arrive before the ordinary IMAP metadata upload.
  // It becomes the immutable stream anchor; 'other' contributes no contact/touch by itself.
  if (original && (
    new Date(original.occurred_at).toISOString() !== new Date(input.occurredAt).toISOString()
    || original.from_email.toLowerCase() !== input.fromEmail.toLowerCase()
    || JSON.stringify(original.to_emails) !== JSON.stringify(input.toEmails)
    || JSON.stringify(original.cc_emails) !== JSON.stringify(input.ccEmails)
  )) {
    return failure('CONFLICT', '分类更正不能改变原邮件时间或收发人');
  }
  return success((head?.classification_revision ?? 0) + 1);
}

export async function refreshMailProjectionIn(
  client: PoolClient,
  input: { contactId: number; customerId: string },
  primary: string | null,
): Promise<void> {
  const params = [input.contactId, input.customerId];
  const corrections = await client.query(`
    SELECT 1 FROM crm_contact_mail_events
    WHERE contact_id=$1 AND customer_id=$2 AND classification_revision IS NOT NULL LIMIT 1`, params);
  if (!corrections.rowCount) return;
  const facts = await client.query(`
    SELECT kind,direction,occurred_at AS "occurredAt",recorded_at AS "recordedAt",
      from_email AS "fromEmail",to_emails AS "toEmails"
    FROM crm_contact_mail_events mf
    WHERE contact_id=$1 AND customer_id=$2 AND ${effectiveMailFactSql()}`, params);
  const manual = await client.query(`
    SELECT act.contact_status AS "contactStatus",act.occurred_at AS "occurredAt",act.recorded_at AS "recordedAt"
    FROM crm_shared_activities act
    WHERE act.contact_id=$1 AND act.customer_id=$2 AND act.opportunity_id IS NULL
      AND act.contact_status IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM crm_contact_mail_events mf WHERE mf.activity_id=act.id)`, params);
  const occurrence = <T extends { occurredAt: Date; recordedAt: Date }>(fact: T) => ({
    ...fact,
    occurredAt: new Date(fact.occurredAt).toISOString(),
    recordedAt: new Date(fact.recordedAt).toISOString(),
  });
  const projected = projectContactMail(primary, facts.rows.map(occurrence), manual.rows.map(occurrence));
  await client.query('UPDATE contacts SET status=$2,crm_touch_status=$3 WHERE id=$1',
    [input.contactId, projected.status, projected.touchStatus]);
}
