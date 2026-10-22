import { describe, expect, it } from 'vitest';
import { projectContactMail, type MailProjectionFact } from '../../server/core/contact-mail-projection';

const email = 'buyer@example.invalid';
const fact = (kind: MailProjectionFact['kind'], occurredAt: string): MailProjectionFact => ({
  kind,
  direction: 'inbound',
  occurredAt,
  recordedAt: occurredAt,
  fromEmail: kind === 'sent' ? 'sales@example.invalid' : email,
  toEmails: kind === 'sent' ? [email] : ['sales@example.invalid'],
});

describe('contact mail status projection', () => {
  it.each([
    ['replied', 'replied'],
    ['bounced', 'bounced'],
    ['autoreply', 'autoreply'],
  ] as const)('maps %s mail to the same contact outcome', (kind, touchStatus) => {
    expect(projectContactMail(email, [fact(kind, '2026-10-22T00:00:00.000Z')], [])).toEqual({ status: touchStatus, touchStatus });
  });

  it('does not downgrade a later delivery outcome to generic contacted', () => {
    const result = projectContactMail(email, [
      fact('replied', '2026-10-22T00:00:00.000Z'),
      fact('sent', '2026-10-22T01:00:00.000Z'),
    ], []);
    expect(result).toEqual({ status: 'replied', touchStatus: 'replied' });
  });
});
