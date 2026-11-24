import { describe, expect, it } from 'vitest';
import { inboxMailNeedsReply, type InboxNeedsReplyMail } from '../../src/shared/inbox-needs-reply';

function mail(overrides: Partial<InboxNeedsReplyMail> = {}): InboxNeedsReplyMail {
  return {
    classification: 'replied',
    isRead: false,
    todoState: 'open',
    senderEmail: 'buyer@example.com',
    analysis: {
      status: 'ready',
      category: 'quote_request',
      priority: 'important',
      requiresAction: true,
      dueHint: '今天 18:00 前',
    },
    ...overrides,
  };
}

describe('inbox needs-reply rule', () => {
  it('derives needs-reply from current analysis and todo state', () => {
    expect(inboxMailNeedsReply(mail())).toBe(true);
    expect(inboxMailNeedsReply(mail({ todoState: 'done' }))).toBe(false);
    expect(inboxMailNeedsReply(mail({ myRole: 'cc' }))).toBe(false);
    expect(inboxMailNeedsReply(mail({ analysis: { ...mail().analysis!, status: 'failed' } }))).toBe(false);
  });
});
