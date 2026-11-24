import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  settings: { enabled: true, intervalMinutes: 60, checks: { mail: true, task: true, quoteReview: true, stalled: true } },
  lastCheckedAt: null as string | null,
  reminders: [] as Array<Record<string, unknown>>,
  aiConfigured: false,
  chatCalls: 0,
  markCalls: [] as Array<{ status: string; error: string | null }>,
  saveSources: [] as string[],
}));

vi.mock('../../src/main/db', () => ({
  getRawDb: () => ({
    prepare: (sql: string) => ({
      all: () => sql.includes('FROM inbox_quote_cards') ? [] : [{
        messageId: 1, priority: 'urgent', summary: '客户在等报价', nextAction: '回复客户',
        dueHint: null, updatedAt: '2026-11-18T09:00:00Z', subject: 'RFQ', fromName: 'Buyer', fromEmail: 'buyer@example.test',
      }],
    }),
  }),
}));

vi.mock('../../src/main/core/assistant-storage', () => ({
  assistantSettings: () => state.settings,
  assistantState: () => ({ lastCheckedAt: state.lastCheckedAt, lastError: null }),
  listAssistantReminders: () => state.reminders,
  saveAssistantReminders: (items: Array<Record<string, unknown>>, source: string) => {
    state.reminders = items.map((item, index) => ({ ...item, source, reminderId: state.reminders[index]?.reminderId ?? `r-${index}` }));
    state.saveSources.push(source);
    return state.reminders;
  },
  markAssistantRun: (status: string, error: string | null) => { state.markCalls.push({ status, error }); state.lastCheckedAt = '2026-11-18T10:00:00Z'; },
  dismissAssistantReminder: () => undefined,
}));

vi.mock('../../src/main/services/ai.service', () => ({
  isAiConfigured: () => state.aiConfigured,
  chatJson: async () => {
    state.chatCalls++;
    return { success: true, data: { items: [{ id: 'mail-1', title: '客户催报价', detail: '尽快回复' }] } };
  },
}));

vi.mock('../../src/main/services/sales-workflow-client.service', () => ({ salesWorkflowClient: () => null }));

import { createAssistantService } from '../../src/main/services/assistant-check.service';

describe('assistant service refresh modes', () => {
  beforeEach(() => {
    state.lastCheckedAt = '2026-11-18T09:30:00Z';
    state.reminders = [];
    state.aiConfigured = true;
    state.chatCalls = 0;
    state.markCalls = [];
    state.saveSources = [];
  });

  it('refreshes source changes with rules before the model interval is due', async () => {
    const service = createAssistantService({ now: () => Date.parse('2026-11-18T10:00:00Z') });
    const result = await service.wake();
    expect(result.ran).toBe(true);
    expect(state.chatCalls).toBe(0);
    expect(state.markCalls).toEqual([]);
    expect(state.reminders[0]).toMatchObject({ title: '客户在等回复：Buyer' });
    expect(state.saveSources).toEqual(['rule']);
  });

  it('uses the model when a source wake crosses the configured interval', async () => {
    state.lastCheckedAt = '2026-11-18T08:00:00Z';
    const service = createAssistantService({ now: () => Date.parse('2026-11-18T10:00:00Z') });
    const result = await service.wake();
    expect(result.ran).toBe(true);
    expect(state.chatCalls).toBe(1);
    expect(state.markCalls).toEqual([{ status: 'ai', error: null }]);
    expect(state.reminders[0]).toMatchObject({ title: '客户催报价' });
    expect(state.saveSources).toEqual(['ai']);
  });

  it('does not run the normal schedule before it is due', async () => {
    const service = createAssistantService({ now: () => Date.parse('2026-11-18T10:00:00Z') });
    expect(await service.run(false)).toMatchObject({ ran: false });
    expect(state.chatCalls).toBe(0);
  });

  it('does not report an unchanged source refresh as an update', async () => {
    state.reminders = [{
      reminderId: 'existing', kind: 'mail', title: '客户在等回复：Buyer', detail: '回复客户', target: 'inbox:1', priority: 1, source: 'rule',
      facts: { messageId: 1, senderEmail: 'buyer@example.test', customerName: 'Buyer', subject: 'RFQ', waitedHours: null, receivedAt: null, lastAction: '回复客户', analysis: '客户在等报价\n回复客户', mailExcerpt: null },
    }];
    const service = createAssistantService({ now: () => Date.parse('2026-11-18T10:00:00Z') });
    expect(await service.wake()).toMatchObject({ ran: false });
    expect(state.chatCalls).toBe(0);
  });
});
