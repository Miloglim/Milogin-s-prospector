import { describe, expect, it } from 'vitest';
import { legacyMailEventInput } from '../../src/main/core/legacy-mail-sync';

describe('legacy mail event conversion', () => {
  it('creates a metadata-only outbound event with a stable key', () => {
    expect(legacyMailEventInput({ localEventId: 8, source: 'interaction', localContactId: 2, centerContactId: 9, centerCustomerId: '1-O', kind: 'sent', direction: 'outbound', occurredAt: '2026-10-16T00:00:00Z', subject: ' Hello ', preview: 'body', mailboxKey: '4', fromEmail: 'Sales@Example.com', toEmails: [' C@Example.com '], ccEmails: [] })).toEqual({ contactId: 9, customerId: '1-O', eventKey: 'legacy-interaction-8', mailboxKey: '4', messageKey: 'legacy-interaction-8', kind: 'sent', direction: 'outbound', occurredAt: '2026-10-16T00:00:00Z', subject: ' Hello ', preview: 'body', fromEmail: 'sales@example.com', toEmails: ['c@example.com'], ccEmails: [] });
  });

  it('uses the source and local id to prevent interaction/inbox collisions', () => {
    const interaction = legacyMailEventInput({ localEventId: 4, source: 'interaction', localContactId: 2, centerContactId: 9, centerCustomerId: '1-O', kind: 'replied', direction: 'inbound', occurredAt: '2026-10-16T00:00:00Z', fromEmail: 'c@example.com', toEmails: ['sales@example.com'], ccEmails: [] });
    const inbox = legacyMailEventInput({ localEventId: 4, source: 'inbox', localContactId: 2, centerContactId: 9, centerCustomerId: '1-O', kind: 'received', direction: 'inbound', occurredAt: '2026-10-16T00:00:00Z', fromEmail: 'c@example.com', toEmails: ['sales@example.com'], ccEmails: [] });
    expect(interaction.eventKey).not.toBe(inbox.eventKey);
  });
});
