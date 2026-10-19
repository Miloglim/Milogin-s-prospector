import { describe, expect, it } from 'vitest';
import { contactMailEvent } from '../../server/services/contact-mail';
import { CONTACT_MAIL_LIMITS } from '../../server/core/contact-mail';
const input = { contactId: 1, customerId: '00000000-0000-4000-8000-000000000001', eventKey: 'event-1', mailboxKey: 'mailbox-1', messageKey: 'message-1', kind: 'replied', direction: 'inbound', occurredAt: '2020-01-02T12:00:00Z', subject: '报价回复', preview: '请报价', fromEmail: 'Person@Example.invalid', toEmails: ['Sales@example.invalid'], ccEmails: [] };
describe('center mail event validation', () => {
  it('allows stage advance only for a confirmed outbound sent event', () => {
    expect(contactMailEvent({ ...input, kind: 'sent', direction: 'outbound', advanceSendStage: true })).toMatchObject({ ok: true, data: { advanceSendStage: true } });
    expect(contactMailEvent({ ...input, kind: 'sent', direction: 'outbound', advanceSendStage: false })).toMatchObject({ ok: true });
    const normalized = contactMailEvent({ ...input, kind: 'sent', direction: 'outbound', advanceSendStage: false });
    if (normalized.ok) expect(normalized.data).not.toHaveProperty('advanceSendStage');
  });
  it.each([true, false, 'true', 1, null])('rejects advance flag on inbound event %j', advanceSendStage => {
    expect(contactMailEvent({ ...input, advanceSendStage }).ok).toBe(false);
  });
  it.each(['true', 1, null, undefined])('rejects nonboolean explicit outbound advance flag %j', advanceSendStage => {
    expect(contactMailEvent({ ...input, kind: 'sent', direction: 'outbound', advanceSendStage }).ok).toBe(false);
  });
  it('accepts explicit center references and canonicalizes email and time', () => {
    expect(contactMailEvent(input)).toMatchObject({ ok: true, data: { fromEmail: 'person@example.invalid', toEmails: ['sales@example.invalid'], occurredAt: '2020-01-02T12:00:00.000Z' } });
  });
  it.each(['ownerUserId', 'touchStatus', 'rawBody', 'html', 'attachments', 'token', 'expectedVersion'])('rejects untrusted or private field %s', key => {
    expect(contactMailEvent({ ...input, [key]: 'private' }).ok).toBe(false);
  });
  it.each([{ contactId: 0 }, { customerId: 'sqlite-1' }, { eventKey: '' }, { mailboxKey: '' }, { messageKey: '' }, { kind: 'queued' }, { direction: 'inbound', kind: 'sent' }, { direction: 'outbound', kind: 'replied' }, { occurredAt: '2020-02-30T12:00:00Z' }, { occurredAt: '2020-01-01' }, { fromEmail: 'a b@example.invalid' }, { toEmails: ['wrong'] }, { toEmails: 'wrong' }, { ccEmails: ['x@example.invalid', 'X@example.invalid'] }, { preview: 'x'.repeat(CONTACT_MAIL_LIMITS.preview + 1) }, { subject: 'x'.repeat(CONTACT_MAIL_LIMITS.subject + 1) }])('rejects invalid metadata %j', fields => {
    expect(contactMailEvent({ ...input, ...fields }).ok).toBe(false);
  });
  it('rejects future timestamps and oversized recipient lists', () => {
    expect(contactMailEvent({ ...input, occurredAt: '2099-01-01T00:00:00Z' }).ok).toBe(false);
    expect(contactMailEvent({ ...input, toEmails: Array.from({ length: CONTACT_MAIL_LIMITS.recipients + 1 }, (_, n) => `${n}@example.invalid`) }).ok).toBe(false);
  });
});
