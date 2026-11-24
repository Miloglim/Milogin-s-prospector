import { describe, expect, it, vi } from 'vitest';

const MAIL_ROWS = [
  { messageId: 43, priority: 'urgent', summary: '客户投诉延误', nextAction: '先确认原因', dueHint: '立即处理', updatedAt: '2026-11-23T00:46:00Z', subject: '[MOCK:complaint] Shipment delay', fromName: 'Diego Tan', fromEmail: 'diego.tan@pacific-cargo.mock', receivedAt: '2026-11-23T00:46:00Z', bodyPreview: 'delay', accountEmail: 'mock.inbox@example.test' },
  { messageId: 47, priority: 'important', summary: '同事请求确认', nextAction: '回复同事', dueHint: null, updatedAt: '2026-11-22T12:46:00Z', subject: '[MOCK:internal_request]', fromName: 'Internal Colleague', fromEmail: 'colleague@yqn.com', receivedAt: '2026-11-22T12:46:00Z', bodyPreview: 'rate', accountEmail: 'mock.inbox@example.test' },
  { messageId: 39, priority: 'important', summary: '客户确认船期', nextAction: '确认舱位', dueHint: null, updatedAt: '2026-11-21T15:10:00Z', subject: '[MOCK:schedule_request] Sailing', fromName: 'Jonas Berg', fromEmail: 'jonas.berg@nordic-freight.mock', receivedAt: '2026-11-21T15:10:00Z', bodyPreview: 'sailing', accountEmail: 'mock.inbox@example.test' },
  { messageId: 41, priority: 'important', summary: '客户追问订单', nextAction: '回复进度', dueHint: null, updatedAt: '2026-11-20T15:10:00Z', subject: '[MOCK:order_followup] Any update', fromName: 'Lena Fischer', fromEmail: 'lena.fischer@rhine-parts.mock', receivedAt: '2026-11-20T15:10:00Z', bodyPreview: 'update', accountEmail: 'mock.inbox@example.test' },
];
const TODO_ROWS = [
  { messageId: 37, priority: 'important', category: 'quote_request', summary: '询价', nextAction: '核对后回复报价', dueHint: '24 小时内', updatedAt: '2026-11-22T12:46:00Z', subject: '[MOCK:quote_request] RFQ', fromName: 'Amelia', fromEmail: 'amelia.route@jade-logistics.mock', receivedAt: '2026-11-22T12:46:00Z', bodyPreview: 'quote', myRole: 'to', accountEmail: 'mock.inbox@example.test' },
  { messageId: 39, priority: 'important', category: 'schedule_request', summary: '船期', nextAction: '确认舱位', dueHint: null, updatedAt: '2026-11-21T15:10:00Z', subject: '[MOCK:schedule_request] Sailing', fromName: 'Jonas Berg', fromEmail: 'jonas.berg@nordic-freight.mock', receivedAt: '2026-11-21T15:10:00Z', bodyPreview: 'sailing', myRole: 'to', accountEmail: 'mock.inbox@example.test' },
  { messageId: 41, priority: 'important', category: 'order_followup', summary: '订单', nextAction: '回复进度', dueHint: null, updatedAt: '2026-11-20T15:10:00Z', subject: '[MOCK:order_followup] Any update', fromName: 'Lena Fischer', fromEmail: 'lena.fischer@rhine-parts.mock', receivedAt: '2026-11-20T15:10:00Z', bodyPreview: 'update', myRole: 'to', accountEmail: 'mock.inbox@example.test' },
  { messageId: 43, priority: 'urgent', category: 'complaint', summary: '投诉', nextAction: '立即处理', dueHint: '立即处理', updatedAt: '2026-11-23T00:46:00Z', subject: '[MOCK:complaint] Shipment delay', fromName: 'Diego Tan', fromEmail: 'diego.tan@pacific-cargo.mock', receivedAt: '2026-11-23T00:46:00Z', bodyPreview: 'delay', myRole: 'to', accountEmail: 'mock.inbox@example.test' },
  { messageId: 45, priority: 'normal', category: 'cooperation', summary: '合作', nextAction: '回复合作意向', dueHint: null, updatedAt: '2026-11-22T12:46:00Z', subject: '[MOCK:cooperation] Agency partnership', fromName: 'Sofia Lopez', fromEmail: 'sofia.lopez@iberia-cargo.mock', receivedAt: '2026-11-22T12:46:00Z', bodyPreview: 'partner', myRole: 'to', accountEmail: 'mock.inbox@example.test' },
];

vi.mock('../../src/main/db', () => ({
  getRawDb: () => ({
    prepare: (sql: string) => ({
      all: () => {
        if (sql.includes('inbox_quote_cards')) return [];
        if (sql.includes('a.confidence')) return TODO_ROWS;
        return MAIL_ROWS;
      },
      get: () => undefined,
    }),
  }),
}));

vi.mock('../../src/main/core/assistant-storage', () => ({
  assistantSettings: () => ({ enabled: true, intervalMinutes: 60, checks: { mail: true, task: true, quoteReview: true, stalled: true } }),
  assistantState: () => ({ lastCheckedAt: null, lastError: null }),
  listAssistantReminders: () => [],
  saveAssistantReminders: () => [],
  markAssistantRun: () => undefined,
  dismissAssistantReminder: () => undefined,
}));

vi.mock('../../src/main/services/ai.service', () => ({ isAiConfigured: () => false, chatJson: async () => ({ success: false, error: 'off' }) }));
vi.mock('../../src/main/services/sales-workflow-client.service', () => ({ salesWorkflowClient: () => null }));

import { createAssistantService } from '../../src/main/services/assistant-check.service';

describe('assistant source queue', () => {
  it('returns the full inbox reply and todo sets instead of the four curated reminders', async () => {
    const service = createAssistantService({ now: () => Date.parse('2026-11-23T08:00:00Z'), port: null });
    const queue = await service.queue();
    expect(queue.filter(item => item.kind === 'mail')).toHaveLength(4);
    expect(queue.filter(item => item.kind === 'task')).toHaveLength(5);
    expect(queue).toHaveLength(9);
    const todo = queue.find(item => item.facts?.messageId === 37 && item.kind === 'task');
    expect(todo).toMatchObject({ target: 'inbox:37', title: '[MOCK:quote_request] RFQ' });
    expect(todo?.facts?.total).toBe(1);
    expect(queue.every(item => item.reminderId.startsWith('queue:'))).toBe(true);
  });
});
