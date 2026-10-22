import {correctionRevisionIn,refreshMailProjectionIn} from './contact-mail-correction-repository';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { failure, success, type Result } from '../../core/crm';
import { CONTACT_MAIL_LIMITS, type ContactMailEvent, type ContactMailEventInput, type ContactMailEventReceipt } from '../../core/contact-mail';
import { CONTACT_ASSIGNMENT_EVENTS, type CenterContactRef } from '../../core/contact-assignments';
import { loadContactIn, canReadContact, contactPermissionsFor, contactDetailIn, recordContactEventIn } from './contact-assignment-repository';
import type { LeadActor } from './lead-repository';
import { FOLLOWUP_TIME_LIMITS } from '../../core/leads';
const MILLISECONDS_PER_SECOND = 1000;
const SELECT = `event_id AS "eventId",actor_id AS "actorId",contact_id AS "contactId",customer_id AS "customerId",event_key AS "eventKey",mailbox_key AS "mailboxKey",message_key AS "messageKey",kind,direction,occurred_at AS "occurredAt",subject,preview,from_email AS "fromEmail",to_emails AS "toEmails",cc_emails AS "ccEmails",recorded_at AS "recordedAt",activity_id::text AS "activityId",classification_correction AS correction,classification_revision AS "correctionRevision"`;
function mapped(row: ContactMailEvent): ContactMailEvent { const {correction,correctionRevision,...event}=row;return { ...event,...(correction?{correction}:{}),...(correctionRevision?{correctionRevision}:{}), occurredAt: new Date(row.occurredAt).toISOString(), recordedAt: new Date(row.recordedAt).toISOString() }; }
/** Called only after the caller has passed contact-specific center authorization. */
export async function contactMailEventsIn(client: PoolClient, input: CenterContactRef): Promise<ContactMailEvent[]> {
  const rows = await client.query(`SELECT ${SELECT} FROM crm_contact_mail_events WHERE contact_id=$1 AND customer_id=$2 ORDER BY occurred_at DESC,recorded_at DESC,event_id DESC LIMIT $3`, [input.contactId, input.customerId, CONTACT_MAIL_LIMITS.history]);
  return rows.rows.map(mapped);
}
export function contactMailFingerprint(input: ContactMailEventInput): string {
  // Keep legacy metadata digests stable. The separate transactional marker owns round advancement.
  const fields:unknown[] = [input.contactId,input.customerId,input.eventKey,input.mailboxKey,input.messageKey,input.kind,input.direction,input.occurredAt,input.subject,input.preview,input.fromEmail,input.toEmails,input.ccEmails];
  if(input.correction)fields.push([input.correction.previousEventKey,input.correction.classification]);
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}
export async function recordContactMailEventIn(client: PoolClient, actor: LeadActor, input: ContactMailEventInput): Promise<Result<ContactMailEventReceipt>> {
  if (input.advanceSendStage !== undefined && (typeof input.advanceSendStage !== 'boolean' || input.kind !== 'sent' || input.direction !== 'outbound')) return failure('INVALID_INPUT', '发送轮次仅允许已确认的发出事件推进');
  // Current center ownership is checked even on replay, never cached from a client assertion.
  const contact = await loadContactIn(client, input, true);
  if (!contact || !canReadContact(actor, contact) || !contactPermissionsFor(actor, contact).canSendMail) return failure('NOT_FOUND', '联系人不存在或不可跟进');
  const primary = contact.email?.trim().toLowerCase();
  const matchingSent = primary && input.kind === 'sent' && input.direction === 'outbound' && input.toEmails.some(email => email.toLowerCase() === primary) && input.fromEmail.toLowerCase() !== primary;
  if (input.advanceSendStage && !matchingSent) return failure('INVALID_INPUT', '发送结果收件人与当前联系人邮箱不一致');
  const advanceStage = async () => {
    await client.query("UPDATE contacts SET stage=CASE stage WHEN 'cold' THEN 'f1' WHEN 'f1' THEN 'f2' WHEN 'f2' THEN 'f3' WHEN 'f3' THEN 'f4' ELSE stage END WHERE id=$1", [input.contactId]);
  };
  const fingerprint = contactMailFingerprint(input), old = (await client.query(`SELECT ${SELECT},digest,send_stage_advanced,archive_only FROM crm_contact_mail_events WHERE actor_id=$1 AND event_key=$2 FOR UPDATE`, [actor.userId, input.eventKey])).rows[0];
  if (old) {
    if (old.digest !== fingerprint) return failure('CONFLICT', '邮件事件键已用于不同事实');
    // IMAP can win the race. A later confirmed receipt upgrades the same fact exactly once.
    if (input.advanceSendStage && !old.send_stage_advanced && !old.archive_only) {
      await advanceStage();
      await client.query('UPDATE crm_contact_mail_events SET send_stage_advanced=true WHERE event_id=$1', [old.eventId]);
      await client.query('UPDATE contacts SET crm_contact_version=crm_contact_version+1,updated_at=now() WHERE id=$1', [input.contactId]);
      await recordContactEventIn(client, actor, contact, CONTACT_ASSIGNMENT_EVENTS.followup, (contact.contactVersion ?? 1) + 1, undefined, old.eventId);
    }
    const detail = await contactDetailIn(client, actor, input); if (!detail.ok) return detail;
    const { digest: _digest, send_stage_advanced: _advanced, archive_only: _archived, ...event } = old;
    return success({ eventId: old.eventId, duplicate: true, event: mapped(event as ContactMailEvent), contact: detail.data.contact });
  }
  const recorded = (await client.query('SELECT clock_timestamp() AS stamp')).rows[0].stamp as Date, occurred = new Date(input.occurredAt);
  if (!Number.isFinite(occurred.getTime()) || occurred.getTime() > recorded.getTime() + FOLLOWUP_TIME_LIMITS.future_skew_seconds * MILLISECONDS_PER_SECOND) return failure('INVALID_INPUT', '邮件发生时间无效');
  const revision=await correctionRevisionIn(client,actor.userId,input);if(!revision.ok)return revision;
  const touch = primary && input.kind === 'replied' && input.direction === 'inbound' && input.fromEmail.toLowerCase() === primary && input.toEmails.length > 0 ? 'replied'
    : primary && input.kind === 'bounced' ? 'bounced'
    : primary && input.kind === 'autoreply' ? 'autoreply'
    : matchingSent ? 'contacted' : null;
  let activityId: string | null = null;
  const correctedStream = input.correction || (await client.query(`
    SELECT 1 FROM crm_contact_mail_events
    WHERE actor_id=$1 AND mailbox_key=$2 AND message_key=$3 AND contact_id=$4 AND customer_id=$5
      AND classification_revision IS NOT NULL LIMIT 1`,
    [actor.userId,input.mailboxKey,input.messageKey,input.contactId,input.customerId])).rowCount;
  // Classification changes and superseded rescans are audit facts, never new contact activities.
  if (touch && !correctedStream) {
    const latest = (await client.query("SELECT max(occurred_at) AS stamp FROM crm_shared_activities WHERE contact_id=$1 AND customer_id=$2 AND opportunity_id IS NULL AND contact_status IS NOT NULL AND method IN ('email','phone','visit','other')", [input.contactId, input.customerId])).rows[0].stamp;
    activityId = (await client.query('INSERT INTO crm_shared_activities(customer_id,interaction_id,actor_id,note,method,occurred_at,recorded_at,created_at,contact_id,contact_status) VALUES($1,NULL,$2,$3,\'email\',$4,$5,$5,$6,$7) RETURNING id::text', [input.customerId, actor.userId, input.subject || input.preview, occurred, recorded, input.contactId, touch])).rows[0].id;
    // A backfill may add evidence without replacing newer manual or mail contact status.
    if (!(touch === 'contacted' && ['replied','bounced','autoreply'].includes(contact.touchStatus)) && (!latest || occurred.getTime() > new Date(latest).getTime() || occurred.getTime() === new Date(latest).getTime() && contact.touchStatus !== touch)) await client.query('UPDATE contacts SET crm_touch_status=$2 WHERE id=$1', [input.contactId, touch]);
  }
  // Delivery classification is derived from mail facts, never a generic contact field edit.
  // Older backfills must not replace a newer mail classification or manual contact result.
  const classification=input.kind==='bounced'?'bounced':input.kind==='autoreply'?'autoreply':touch==='replied'?'replied':touch==='contacted'&&contact.touchStatus!=='replied'?'reached':null;
  if(classification){
    const newer=(await client.query("SELECT 1 FROM crm_contact_mail_events WHERE contact_id=$1 AND customer_id=$2 AND NOT archive_only AND occurred_at>$3 UNION ALL SELECT 1 FROM crm_shared_activities WHERE contact_id=$1 AND customer_id=$2 AND contact_status IS NOT NULL AND occurred_at>$3 LIMIT 1",[input.contactId,input.customerId,occurred])).rowCount;
    if(!newer)await client.query('UPDATE contacts SET status=$2 WHERE id=$1',[input.contactId,classification]);
  }
  const eventId = randomUUID();
  await client.query('INSERT INTO crm_contact_mail_events(event_id,actor_id,contact_id,customer_id,event_key,mailbox_key,message_key,kind,direction,occurred_at,subject,preview,from_email,to_emails,cc_emails,digest,recorded_at,activity_id,classification_correction,classification_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17,$18,$19::jsonb,$20)', [eventId,actor.userId,input.contactId,input.customerId,input.eventKey,input.mailboxKey,input.messageKey,input.kind,input.direction,occurred,input.subject,input.preview,input.fromEmail,JSON.stringify(input.toEmails),JSON.stringify(input.ccEmails),fingerprint,recorded,activityId,input.correction?JSON.stringify(input.correction):null,revision.data]);
  if (input.advanceSendStage) {
    await advanceStage();
    await client.query('UPDATE crm_contact_mail_events SET send_stage_advanced=true WHERE event_id=$1', [eventId]);
  }
  await refreshMailProjectionIn(client,input,contact.email);
  await client.query('UPDATE contacts SET crm_contact_version=crm_contact_version+1,updated_at=now() WHERE id=$1', [input.contactId]);
  await recordContactEventIn(client,actor,contact,CONTACT_ASSIGNMENT_EVENTS.followup,(contact.contactVersion ?? 1)+1,activityId ?? undefined,eventId);
  const detail = await contactDetailIn(client, actor, input); if (!detail.ok) return detail;
  return success({ eventId, duplicate: false, contact: detail.data.contact, event: { ...input, eventId, actorId: actor.userId, recordedAt: recorded.toISOString(), occurredAt: occurred.toISOString(), activityId,...(revision.data?{correctionRevision:revision.data}:{}) } });
}
