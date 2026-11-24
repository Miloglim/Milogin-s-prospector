// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App as AntApp } from 'antd';
import { AssistantReminders } from '../../src/renderer/components/AssistantReminders';

const snapshot = {
  reminders: [
    {
      reminderId: 'mail-1', kind: 'mail', title: '客户在等回复：Acme', detail: '已等 6 小时',
      target: 'inbox:1', priority: 1, source: 'ai', createdAt: '2026-11-19T01:00:00.000Z',
      facts: { senderEmail: 'buyer@acme.com', customerName: 'Acme', subject: 'RFQ 40HQ', waitedHours: 6, lastAction: '想要目的港费用', analysis: '客户在等报价。', mailExcerpt: 'Please quote.' },
    },
    {
      reminderId: 'quote-1', kind: 'quote', title: '报价待你确认：Nordwind', detail: 'Shanghai -> Hamburg · CMA · USD 1800',
      target: 'inbox:2', priority: 2, source: 'ai', createdAt: '2026-11-19T02:00:00.000Z',
      facts: {
        customerName: 'Nordwind', customerEmail: 'buyer@nordwind.de', subject: '询价 Shanghai -> Hamburg', pol: 'Shanghai', pod: 'Hamburg',
        carrier: 'CMA', containerType: '40HQ', price: 1800, currency: 'USD', validTo: '2026-11-30', selectedCandidateId: 'c1', candidates: [
          { id: 'c1', carrier: 'CMA', pol: 'Shanghai', pod: 'Hamburg', containerType: '40HQ', price: 1800, currency: 'USD', validTo: '2026-11-30' },
          { id: 'c2', carrier: 'MSC', pol: 'Shanghai', pod: 'Hamburg', containerType: '40HQ', price: 1900, currency: 'USD', validTo: '2026-11-30' },
        ],
      },
    },
    {
      reminderId: 'task-1', kind: 'task', title: '待办到期：2 项', detail: '2 项已逾期',
      target: 'customers:a:1', priority: 2, source: 'rule', createdAt: '2026-11-19T03:00:00.000Z',
      facts: { total: 2, items: [
        { id: 't1', title: '待办：核对条款', detail: '逾期 1 天', target: 'customers:a:1', meta: '逾期 1 天' },
        { id: 't2', title: '待办：补跟进', detail: '今天到期', target: 'customers:b:1', meta: '今天到期' },
      ] },
    },
  ],
  settings: { enabled: true, intervalMinutes: 60, checks: { mail: true, task: true, quoteReview: true, stalled: true } },
  lastCheckedAt: '2026-11-19T01:00:00.000Z', lastError: null, aiConfigured: true, due: false,
};

describe('assistant workspace', () => {
  let root: Root; let host: HTMLDivElement;
  const invoke = vi.fn(async (channel: string) => channel === 'assistant:snapshot' ? { success: true, data: snapshot } : { success: true, data: null });

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
    Object.defineProperty(window, 'api', { configurable: true, value: { invoke, on: () => () => {} } });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await act(async () => root.render(<AntApp><AssistantReminders variant="workspace" /></AntApp>));
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); invoke.mockClear(); });

  it('shows a task queue and the selected task detail without a chat input', () => {
    expect(host.querySelector('[aria-label="任务队列"]')).toBeTruthy();
    expect(host.querySelector('[aria-label="任务详情"]')).toBeTruthy();
    expect(host.textContent).toContain('RFQ 40HQ');
    expect(host.textContent).toContain('buyer@acme.com');
    expect(host.querySelector('textarea')).toBeNull();
  });

  it('filters to quotes and renders candidates in the detail panel', async () => {
    const quoteTab = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(button => button.textContent?.includes('报价'))!;
    await act(async () => quoteTab.click());
    expect(host.querySelector('[aria-label="任务详情"] h2')?.textContent).toContain('Shanghai -> Hamburg');
    expect(host.querySelector('[aria-label="任务详情"] header p')?.textContent).toContain('Nordwind');
    expect(host.textContent).toContain('匹配报价');
    expect(host.textContent).toContain('USD 1900');
  });

  it('opens the aggregated task list from the queue', async () => {
    const taskTab = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(button => button.textContent?.includes('待办'))!;
    await act(async () => taskTab.click());
    expect(host.querySelector('[aria-label="任务详情"] h2')?.textContent).toContain('待办到期');
    expect(host.textContent).toContain('待办：核对条款');
    expect(host.textContent).toContain('待办：补跟进');
  });
});
