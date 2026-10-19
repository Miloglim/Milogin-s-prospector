import { failure, success, type Result } from '../core/crm';
import type { TokenPort } from '../core/auth';
import {
  SEND_AUTHORIZATION_LIMITS as LIMITS,
  type SendAuthorizationInput, type SendAcceptanceInput, type SendAcceptanceRepository,
} from '../core/send-acceptance';
import { CONTACT_MAIL_LIMITS } from '../core/contact-mail';
import { contactMailEvent } from './contact-mail';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, max: number, min = 0): value is string {
  return typeof value === 'string' && value.trim().length >= min && value.length <= max && !value.includes('\0');
}
function email(value: unknown): value is string {
  return text(value, CONTACT_MAIL_LIMITS.email, 1) && EMAIL.test(value);
}
function invalid(): Result<never> { return failure('INVALID_INPUT', '发送授权或回执参数无效'); }

export function sendAuthorization(value: unknown): Result<SendAuthorizationInput> {
  if (!record(value) || Object.keys(value).some(key => !['sendKey','fromEmail','subject','recipients','ccEmails'].includes(key))
    || !text(value.sendKey, LIMITS.sendKey, 1) || !email(value.fromEmail)
    || !text(value.subject, CONTACT_MAIL_LIMITS.subject) || !Array.isArray(value.recipients)
    || !value.recipients.length || value.recipients.length > LIMITS.recipients) return invalid();
  if (value.ccEmails !== undefined && (!Array.isArray(value.ccEmails) || value.ccEmails.length > LIMITS.recipients || !value.ccEmails.every(email))) return invalid();
  const ccEmails = [...new Set(((value.ccEmails ?? []) as string[]).map(value => value.toLowerCase()))].sort();
  const recipients: SendAuthorizationInput['recipients'] = [];
  for (const target of value.recipients) {
    if (!record(target) || Object.keys(target).some(key => !['contactId','customerId','email'].includes(key))
      || !Number.isSafeInteger(target.contactId) || Number(target.contactId) < 1
      || typeof target.customerId !== 'string' || !UUID.test(target.customerId) || !email(target.email)) return invalid();
    recipients.push({ contactId: Number(target.contactId), customerId: target.customerId, email: target.email.toLowerCase() });
  }
  if (new Set(recipients.map(target => `${target.contactId}:${target.customerId}`)).size !== recipients.length) return invalid();
  return success({ sendKey: value.sendKey, fromEmail: value.fromEmail.toLowerCase(), subject: value.subject, recipients, ccEmails });
}

export function sendAcceptance(value: unknown): Result<SendAcceptanceInput> {
  if (!record(value) || Object.keys(value).some(key => !['authorizationId','event','observedEvent'].includes(key))
    || typeof value.authorizationId !== 'string' || !UUID.test(value.authorizationId)) return invalid();
  const parsed = contactMailEvent(value.event);
  if (!parsed.ok) return parsed;
  if (parsed.data.kind !== 'sent' || parsed.data.direction !== 'outbound' || parsed.data.correction) return invalid();
  if (value.observedEvent !== undefined) {
    const observed = contactMailEvent(value.observedEvent);
    if (!observed.ok) return observed;
    if (observed.data.kind !== 'sent' || observed.data.direction !== 'outbound' || observed.data.correction) return invalid();
    return success({ authorizationId: value.authorizationId, event: parsed.data, observedEvent: observed.data });
  }
  return success({ authorizationId: value.authorizationId, event: parsed.data });
}

export function createSendAcceptanceService(repository: SendAcceptanceRepository, tokens: TokenPort) {
  function run<T, I>(token: string, value: unknown, parse: (value: unknown) => Result<I>,
    work: (hash: string, input: I) => Promise<Result<T>>): Promise<Result<T>> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return Promise.resolve(failure('UNAUTHORIZED', '会话无效'));
    const parsed = parse(value);
    return parsed.ok ? work(tokens.hash(token), parsed.data) : Promise.resolve(parsed);
  }
  return {
    authorize: (token: string, value: unknown) => run(token, value, sendAuthorization,
      (hash, input) => repository.authorizeSend(hash, input)),
    accept: (token: string, value: unknown) => run(token, value, sendAcceptance,
      (hash, input) => repository.acceptSend(hash, input)),
  };
}
export type SendAcceptanceService = ReturnType<typeof createSendAcceptanceService>;
