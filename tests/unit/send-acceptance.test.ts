import { describe, it, expect, vi } from 'vitest';
import { sendAuthorization, sendAcceptance, createSendAcceptanceService } from '../../server/services/send-acceptance';
import { success } from '../../server/core/crm';
import type { SendAcceptanceRepository } from '../../server/core/send-acceptance';

const customerId = '00000000-0000-4000-8000-000000000001';
const authorizationId = '00000000-0000-4000-8000-000000000002';
const target = { contactId: 1, customerId, email: 'Customer@example.invalid' };
const authorization = { sendKey: 'send-attempt', fromEmail: 'Sender@example.invalid', subject: 'Quote', recipients: [target], ccEmails: ['Copy@example.invalid'] };
const event = { contactId: 1, customerId, eventKey: 'smtp:accepted', mailboxKey: 'mailbox', messageKey: 'message',
  kind: 'sent', direction: 'outbound', occurredAt: '2026-10-16T00:00:00.000Z', subject: 'Quote', preview: '',
  fromEmail: 'sender@example.invalid', toEmails: ['customer@example.invalid'], ccEmails: ['copy@example.invalid'], advanceSendStage: true };

describe('send authorization and acceptance validation', () => {
  it('normalizes bound addresses and rejects malformed or duplicate targets before repository access', () => {
    expect(sendAuthorization(authorization)).toMatchObject({ ok: true, data: { fromEmail: 'sender@example.invalid', ccEmails: ['copy@example.invalid'], recipients: [{ email: 'customer@example.invalid' }] } });
    for (const value of [
      { ...authorization, recipients: [] },
      { ...authorization, recipients: [target, target] },
      { ...authorization, recipients: [{ ...target, email: 'not-an-address' }] },
      { ...authorization, ccEmails: ['not-an-address'] },
      { ...authorization, bypassPermission: true },
      { ...authorization, sendKey: '' },
    ]) expect(sendAuthorization(value)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });
  it('accepts only outbound SMTP facts and rejects classifier corrections or client privilege assertions', () => {
    expect(sendAcceptance({ authorizationId, event })).toMatchObject({ ok: true });
    expect(sendAcceptance({ authorizationId, event, observedEvent: { ...event, preview: 'IMAP' } })).toMatchObject({ ok: true, data: { observedEvent: { preview: 'IMAP' } } });
    for (const value of [
      { authorizationId, event: { ...event, kind: 'received', direction: 'inbound' } },
      { authorizationId, event: { ...event, correction: { previousEventKey: null, classification: 'other' } } },
      { authorizationId: 'invalid', event },
      { authorizationId, event, previouslyAllowed: true },
    ]) expect(sendAcceptance(value)).toMatchObject({ ok: false });
  });
  it('requires a real session shape and never calls persistence for invalid payloads', async () => {
    const repository = { authorizeSend: vi.fn().mockResolvedValue(success([])), acceptSend: vi.fn() } as unknown as SendAcceptanceRepository;
    const hash = vi.fn().mockReturnValue('hashed-session');
    const service = createSendAcceptanceService(repository, { hash } as never);
    expect(await service.authorize('invalid', authorization)).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
    expect(await service.authorize('a'.repeat(43), { ...authorization, recipients: [] })).toMatchObject({ ok: false });
    expect(repository.authorizeSend).not.toHaveBeenCalled();
    expect(await service.authorize('a'.repeat(43), authorization)).toEqual(success([]));
    expect(repository.authorizeSend).toHaveBeenCalledWith('hashed-session', expect.objectContaining({ fromEmail: 'sender@example.invalid' }));
  });
});
