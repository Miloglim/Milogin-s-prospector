// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AssistantActionCard } from '../../src/renderer/components/AssistantBriefingCards';
import type { AssistantReminder } from '../../src/shared/assistant';

const base = { reminderId: 'r', title: 't', detail: 'd', target: 'inbox:1', priority: 1 as const, source: 'ai' as const, createdAt: '2026-11-19T00:00:00.000Z' };

describe('assistant action card variants', () => {
  let root: Root; let host: HTMLDivElement;
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

  it('renders a mail card with facts and AI analysis on expand', async () => {
    const item: AssistantReminder = { ...base, kind: 'mail', title: '客户在等回复：Buyer', facts: {
      senderEmail: 'buyer@example.com', subject: 'RFQ 40HQ', waitedHours: 6, lastAction: '想要目的港费用',
      analysis: '客户在等报价，建议先确认目的港费用。', mailExcerpt: 'Please quote your best rate.',
    } };
    await act(async () => root.render(<AssistantActionCard item={item} onOpen={() => {}} />));
    expect(host.textContent).toContain('RFQ 40HQ');
    expect(host.textContent).toContain('buyer@example.com');
    expect(host.textContent).toContain('已等 6 小时');
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="展开详情"]')!.click());
    expect(host.textContent).toContain('AI 分析');
    expect(host.textContent).toContain('客户在等报价');
  });

  it('renders quote candidates and the original mail on expand', async () => {
    const onSelect = vi.fn();
    const item: AssistantReminder = { ...base, kind: 'quote', title: '报价待你确认：Acme', target: 'inbox:2', facts: {
      messageId: 2, customerName: 'Acme', customerEmail: 'buyer@acme.com', subject: '询价 Shanghai → Santos',
      pol: 'Shanghai', pod: 'Santos', carrier: 'CMA', containerType: '40HQ', price: 1850, currency: 'USD', validTo: '2026-11-30',
      selectedCandidateId: 'c1', mailExcerpt: 'Please quote 40HQ.',
      candidates: [
        { id: 'c1', carrier: 'CMA', pol: 'Shanghai', pod: 'Santos', containerType: '40HQ', price: 1850, currency: 'USD', validTo: '2026-11-30' },
        { id: 'c2', carrier: 'MSC', pol: 'Shanghai', pod: 'Santos', containerType: '40HQ', price: 1900, currency: 'USD', validTo: '2026-11-30' },
      ],
    } };
    await act(async () => root.render(<AssistantActionCard item={item} onOpen={() => {}} onSelectCandidate={onSelect} />));
    expect(host.textContent).toContain('USD 1850');
    expect(host.textContent).toContain('buyer@acme.com');
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="展开详情"]')!.click());
    expect(host.textContent).toContain('其他匹配条目');
    expect(host.textContent).toContain('邮件原文');
    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent?.trim() === '选这条')!.click());
    expect(onSelect).toHaveBeenCalledWith('c2');
  });

  it('renders an aggregated task list on expand', async () => {
    const item: AssistantReminder = { ...base, kind: 'task', title: '待办到期：2 项', facts: {
      total: 2,
      items: [
        { id: 't1', title: '待办：核对条款', detail: '逾期 1 天', target: 'customers:a:1', meta: '逾期 1 天' },
        { id: 't2', title: '待办：补跟进', detail: '今天到期', target: 'customers:b:1', meta: '今天到期' },
      ],
    } };
    await act(async () => root.render(<AssistantActionCard item={item} onOpen={() => {}} onOpenTarget={() => {}} />));
    expect(host.textContent).toContain('待办到期：2 项');
    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent?.includes('查看 2 项'))!.click());
    expect(host.textContent).toContain('待办：核对条款');
    expect(host.textContent).toContain('待办：补跟进');
  });
});
