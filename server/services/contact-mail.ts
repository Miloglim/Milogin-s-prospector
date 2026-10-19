import { failure, success, type Result } from '../core/crm';
import type { TokenPort } from '../core/auth';
import { MAIL_CLASSIFICATIONS, CONTACT_MAIL_KINDS, CONTACT_MAIL_LIMITS as L, type ContactMailEventInput, type ContactMailRepository } from '../core/contact-mail';
import { FOLLOWUP_TIME_LIMITS } from '../core/leads';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const MILLISECONDS_PER_SECOND = 1000;
const TIME_LIMITS = { hours: 24, minutes: 60, seconds: 60 } as const;
const FIELDS = ['contactId', 'customerId', 'eventKey', 'mailboxKey', 'messageKey', 'kind', 'direction', 'occurredAt', 'subject', 'preview', 'fromEmail', 'toEmails', 'ccEmails', 'advanceSendStage', 'correction'];
function text(value: unknown, max: number, min = 0): value is string { return typeof value === 'string' && value.length <= max && value.trim().length >= min && !value.includes('\0'); }
function email(value: unknown): value is string { return text(value, L.email, 1) && EMAIL.test(value); }
function recipients(value: unknown): value is string[] { return Array.isArray(value) && value.length <= L.recipients && value.every(email) && new Set(value.map(item => item.toLowerCase())).size === value.length; }
function occurrence(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!parts) return false;
  const day = new Date(`${parts[1]}-${parts[2]}-${parts[3]}T00:00:00Z`), stamp = Date.parse(value);
  return day.getUTCFullYear() === Number(parts[1]) && day.getUTCMonth() + 1 === Number(parts[2]) && day.getUTCDate() === Number(parts[3]) && Number(parts[4]) < TIME_LIMITS.hours && Number(parts[5]) < TIME_LIMITS.minutes && Number(parts[6]) < TIME_LIMITS.seconds && (parts[8] === undefined || Number(parts[8]) < TIME_LIMITS.hours && Number(parts[9]) < TIME_LIMITS.minutes) && Number.isFinite(stamp) && stamp <= Date.now() + FOLLOWUP_TIME_LIMITS.future_skew_seconds * MILLISECONDS_PER_SECOND;
}
export function contactMailEvent(value: unknown): Result<ContactMailEventInput> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return failure('INVALID_INPUT', '邮件事件参数无效');
  const v = value as Record<string, unknown>;
  if (Object.hasOwn(v, 'advanceSendStage') && (typeof v.advanceSendStage !== 'boolean' || v.kind !== 'sent' || v.direction !== 'outbound')) return failure('INVALID_INPUT', '发送轮次仅允许已确认的发出事件推进');
  if (Object.keys(v).some(key => !FIELDS.includes(key)) || !Number.isSafeInteger(v.contactId) || Number(v.contactId) < 1 || typeof v.customerId !== 'string' || !UUID.test(v.customerId) || !text(v.eventKey, L.key, 1) || !text(v.mailboxKey, L.mailboxKey, 1) || !text(v.messageKey, L.key, 1) || !CONTACT_MAIL_KINDS.includes(v.kind as never) || !['inbound', 'outbound'].includes(v.direction as string) || v.kind === 'sent' && v.direction !== 'outbound' || ['received', 'replied', 'autoreply', 'bounced'].includes(v.kind as string) && v.direction !== 'inbound' || !occurrence(v.occurredAt) || !text(v.subject, L.subject) || !text(v.preview, L.preview) || !email(v.fromEmail) || !recipients(v.toEmails) || !recipients(v.ccEmails)) return failure('INVALID_INPUT', '邮件事件参数无效');
  if (Object.hasOwn(v,'correction')) {
    const correction=v.correction;
    if(!correction||typeof correction!=='object'||Array.isArray(correction))return failure('INVALID_INPUT','邮件分类更正参数无效');
    const c=correction as Record<string,unknown>;
    if(Object.keys(c).length!==2||Object.keys(c).some(k=>!['previousEventKey','classification'].includes(k))||!MAIL_CLASSIFICATIONS.includes(c.classification as never)||c.previousEventKey!==null&&!text(c.previousEventKey,L.key,1)||v.direction!=='inbound'||Object.hasOwn(v,'advanceSendStage')||v.kind!==(c.classification==='other'?'received':c.classification))return failure('INVALID_INPUT','邮件分类更正参数无效');
  }
  const normalized = { ...(v as unknown as ContactMailEventInput), occurredAt: new Date(v.occurredAt).toISOString(), fromEmail: v.fromEmail.toLowerCase(), toEmails: v.toEmails.map(item => item.toLowerCase()), ccEmails: v.ccEmails.map(item => item.toLowerCase()) };
  if (normalized.advanceSendStage === false) delete normalized.advanceSendStage;
  return success(normalized);
}
export function createContactMailService(repo: ContactMailRepository, tokens: TokenPort) {
  return { record: (token: string, value: unknown) => {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return Promise.resolve(failure('UNAUTHORIZED', '会话无效'));
    const parsed = contactMailEvent(value);
    return parsed.ok ? repo.recordContactMailEvent(tokens.hash(token), parsed.data) : Promise.resolve(parsed);
  } };
}
export type ContactMailService = ReturnType<typeof createContactMailService>;
