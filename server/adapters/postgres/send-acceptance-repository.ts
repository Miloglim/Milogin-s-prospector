import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { failure, success, type Result } from '../../core/crm';
import { SEND_AUTHORIZATION_LIMITS as LIMITS, type SendAuthorizationInput, type SendAuthorization, type SendAcceptanceInput, type SendAcceptanceReceipt } from '../../core/send-acceptance';
import { loadContactIn, canReadContact, contactPermissionsFor } from './contact-assignment-repository';
import { contactMailFingerprint, recordContactMailEventIn } from './contact-mail-repository';
import { FOLLOWUP_TIME_LIMITS } from '../../core/leads';
import type { LeadActor } from './lead-repository';

const MILLISECONDS_PER_SECOND = 1000;
const normalized = (emails: string[]) => [...new Set(emails.map(email => email.toLowerCase()))].sort();
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
interface AuthorizationRow {
  authorization_id: string; contact_id: number; customer_id: string; recipient_email: string;
  from_email: string; subject: string; issued_at: Date; expires_at: Date;
}
function mapped(row: AuthorizationRow): SendAuthorization {
  return { authorizationId: row.authorization_id, contactId: row.contact_id, customerId: row.customer_id,
    recipientEmail: row.recipient_email, fromEmail: row.from_email, subject: row.subject,
    issuedAt: new Date(row.issued_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString() };
}
export async function authorizeSendIn(client: PoolClient, actor: LeadActor, input: SendAuthorizationInput): Promise<Result<SendAuthorization[]>> {
  const targets = [...input.recipients].sort((a, b) => a.contactId - b.contactId || a.customerId.localeCompare(b.customerId));
  const cc = normalized(input.ccEmails ?? []);
  const requestFingerprint = fingerprint([input.fromEmail.toLowerCase(), input.subject, targets.map(target => [target.contactId, target.customerId, target.email.toLowerCase()]), cc]);
  const owners: (string | null)[] = [];
  // Validate every target before writing any authorization. A partially valid batch must never send.
  for (const target of targets) {
    const contact = await loadContactIn(client, target, true);
    if (!contact || !canReadContact(actor, contact) || !contactPermissionsFor(actor, contact).canSendMail) return failure('NOT_FOUND', '联系人不存在或不可发送');
    if (contact.email?.toLowerCase() !== target.email.toLowerCase() || input.fromEmail.toLowerCase() === target.email.toLowerCase()) return failure('CONFLICT', '联系人邮箱已变化');
    owners.push(contact.ownerUserId);
  }
  const old = await client.query('SELECT * FROM crm_send_authorizations WHERE actor_id=$1 AND send_key=$2 ORDER BY contact_id,customer_id FOR UPDATE', [actor.userId, input.sendKey]);
  const now: Date = (await client.query('SELECT clock_timestamp() AS stamp')).rows[0].stamp;
  if (old.rowCount) {
    if (old.rows.length !== targets.length || old.rows.some((row, index) => row.request_fingerprint !== requestFingerprint || row.consumed_event_id || row.owner_user_id !== owners[index] || new Date(row.expires_at) <= now)) return failure('CONFLICT', '发送编号已使用或已过期');
    return success(old.rows.map(mapped));
  }
  const expires = new Date(now.getTime() + LIMITS.attempt_seconds * MILLISECONDS_PER_SECOND);
  const allowed = normalized(targets.map(target => target.email));
  const result: SendAuthorization[] = [];
  for (const [index, target] of targets.entries()) {
    const inserted = await client.query(`INSERT INTO crm_send_authorizations(actor_id,send_key,contact_id,customer_id,recipient_email,from_email,subject,authorized_recipients,authorized_cc,request_fingerprint,owner_user_id,allow_advance_stage,issued_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,true,$12,$13) RETURNING *`,
      [actor.userId, input.sendKey, target.contactId, target.customerId, target.email.toLowerCase(), input.fromEmail.toLowerCase(), input.subject, JSON.stringify(allowed), JSON.stringify(cc), requestFingerprint, owners[index], now, expires]);
    result.push(mapped(inserted.rows[0]));
  }
  return success(result);
}

export async function acceptSendIn(client: PoolClient, actor: LeadActor, input: SendAcceptanceInput): Promise<Result<SendAcceptanceReceipt>> {
  const event = input.event;
  if (event.kind !== 'sent' || event.direction !== 'outbound' || event.correction) return failure('INVALID_INPUT', '仅允许已接受的发送事实');
  if (input.observedEvent) {
    const observed = input.observedEvent;
    if (observed.contactId !== event.contactId || observed.customerId !== event.customerId || observed.eventKey !== event.eventKey
      || observed.mailboxKey !== event.mailboxKey || observed.messageKey !== event.messageKey
      || observed.fromEmail.toLowerCase() !== event.fromEmail.toLowerCase() || observed.subject !== event.subject
      || observed.kind !== 'sent' || observed.direction !== 'outbound' || observed.correction) return failure('CONFLICT', '原邮件证据不属于同一发送');
  }
  const grant = (await client.query('SELECT * FROM crm_send_authorizations WHERE authorization_id=$1 AND actor_id=$2 FOR UPDATE', [input.authorizationId, actor.userId])).rows[0];
  if (!grant) return failure('NOT_FOUND', '发送授权不存在');
  const receiptFingerprint = fingerprint([contactMailFingerprint(event), event.advanceSendStage ?? false, input.observedEvent ? contactMailFingerprint(input.observedEvent) : null]);
  if (grant.consumed_event_id) {
    if (grant.consumed_fingerprint !== receiptFingerprint) return failure('CONFLICT', '发送授权已被其他回执消费');
    return success({ eventId: grant.consumed_event_id, duplicate: true, archivedAfterRevocation: grant.archived_after_revocation });
  }
  const to = normalized(event.toEmails), cc = normalized(event.ccEmails);
  const occurred = new Date(event.occurredAt).getTime(), skew = LIMITS.clock_skew_seconds * MILLISECONDS_PER_SECOND;
  const now: Date = (await client.query('SELECT clock_timestamp() AS stamp')).rows[0].stamp;
  if (!Number.isFinite(occurred) || occurred > now.getTime() + FOLLOWUP_TIME_LIMITS.future_skew_seconds * MILLISECONDS_PER_SECOND) return failure('INVALID_INPUT', '邮件发生时间无效或尚未发生');
  if (event.contactId !== grant.contact_id || event.customerId !== grant.customer_id || event.subject !== grant.subject || event.fromEmail.toLowerCase() !== grant.from_email
    || !to.includes(grant.recipient_email) || to.some(email => !grant.authorized_recipients.includes(email))
    || JSON.stringify(cc) !== JSON.stringify(grant.authorized_cc) || event.advanceSendStage && !grant.allow_advance_stage
    || !Number.isFinite(occurred) || occurred < new Date(grant.issued_at).getTime() - skew || occurred > new Date(grant.expires_at).getTime() + skew) return failure('CONFLICT', '发送回执与授权不一致');
  const old = (await client.query('SELECT event_id,digest FROM crm_contact_mail_events WHERE actor_id=$1 AND event_key=$2 FOR UPDATE', [actor.userId, event.eventKey])).rows[0];
  let storedEvent = event;
  if (old) {
    if ((await client.query('SELECT 1 FROM crm_send_authorizations WHERE consumed_event_id=$1', [old.event_id])).rowCount) return failure('CONFLICT', '邮件事实已属于其他回执');
    if (old.digest !== contactMailFingerprint(event)) {
      const observed = input.observedEvent;
      if (!observed || old.digest !== contactMailFingerprint(observed)) return failure('CONFLICT', '原邮件证据与发送回执不一致');
      // Preserve the already committed IMAP fact; SMTP only supplies authorization evidence and advancement.
      storedEvent = { ...observed, advanceSendStage: event.advanceSendStage };
    }
  }
  const contact = await loadContactIn(client, event, true);
  const current = contact && contact.ownerUserId === grant.owner_user_id && contact.email?.toLowerCase() === grant.recipient_email && canReadContact(actor, contact) && contactPermissionsFor(actor, contact).canSendMail;
  let eventId: string, duplicate: boolean;
  if (current) {
    const recorded = await recordContactMailEventIn(client, actor, storedEvent);
    if (!recorded.ok) return recorded;
    eventId = recorded.data.eventId; duplicate = recorded.data.duplicate;
  } else {
    // Historical evidence only: no activity, stage, contact version, or summary mutation.
    eventId = old?.event_id ?? randomUUID(); duplicate = !!old;
    if (!old) await client.query(`INSERT INTO crm_contact_mail_events(event_id,actor_id,contact_id,customer_id,event_key,mailbox_key,message_key,kind,direction,occurred_at,subject,preview,from_email,to_emails,cc_emails,digest,archive_only)
      VALUES($1,$2,$3,$4,$5,$6,$7,'sent','outbound',$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,true)`,
      [eventId, actor.userId, event.contactId, event.customerId, event.eventKey, event.mailboxKey, event.messageKey, event.occurredAt, event.subject, event.preview, event.fromEmail, JSON.stringify(event.toEmails), JSON.stringify(event.ccEmails), contactMailFingerprint(event)]);
    await client.query(`INSERT INTO identity.outbox(event_type,user_id,product_id,revision,customer_id,payload,recipient_user_ids)
      VALUES('crm.contact.mail.archived',$1,'crm',1,$2,$3::jsonb,'{}'::uuid[])`,
      [actor.userId, event.customerId, JSON.stringify({ contactId: event.contactId, customerId: event.customerId, mailEventId: eventId, authorizationId: input.authorizationId })]);
  }
  await client.query('UPDATE crm_send_authorizations SET consumed_event_id=$2,consumed_fingerprint=$3,archived_after_revocation=$4 WHERE authorization_id=$1', [input.authorizationId, eventId, receiptFingerprint, !current]);
  return success({ eventId, duplicate, archivedAfterRevocation: !current });
}
