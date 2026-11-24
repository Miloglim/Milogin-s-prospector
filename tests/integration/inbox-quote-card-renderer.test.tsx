// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { InboxQuoteCardView } from '../../src/renderer/pages/inbox/InboxQuoteCard';
import type { InboxQuoteCard } from '../../src/shared/inbox';

const card: InboxQuoteCard = {
  messageId: 7,
  messageKey: 'synthetic-message',
  caseId: 'synthetic-case',
  quoteCaseId: 'synthetic-quote-case',
  quoteId: 'synthetic-quote',
  state: 'ready',
  fields: {
    pol: { value: 'Shanghai', source: 'email', evidence: ['POL Shanghai'], confidence: 0.9, resolver: 'ports' },
    pod: { value: 'Santos', source: 'email', evidence: ['POD Santos'], confidence: 0.9, resolver: 'ports' },
  },
  missingFields: [],
  selectedCandidate: null,
  candidates: [
    { id: 'rate-1', carrier: 'CMA', pol: 'Shanghai', pod: 'Santos', containerType: '40HQ', price: 1800, currency: 'USD', etd: '2026-11-30', validFrom: null, validTo: '2026-12-15', sourceUpdatedAt: null, evidence: [] },
    { id: 'rate-2', carrier: 'MSC', pol: 'Shanghai', pod: 'Santos', containerType: '40HQ', price: 1850, currency: 'USD', etd: '2026-12-02', validFrom: null, validTo: '2026-12-20', sourceUpdatedAt: null, evidence: [] },
  ],
  summary: '客户询问上海到桑托斯 40HQ 运价',
  error: null,
  updatedAt: '2026-11-17T00:00:00Z',
};

describe('inbox quote card', () => {
  let root: Root;
  let host: HTMLDivElement;
  const invoke = vi.fn(async (channel: string) => channel === 'inbox:quoteSelect' ? { success: true, data: { ...card, selectedCandidate: card.candidates[0] } } : { success: true, data: null });

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
    Object.defineProperty(window, 'api', { configurable: true, value: { invoke, on: vi.fn(() => vi.fn()) } });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<InboxQuoteCardView card={card} onUpdated={() => undefined} />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    invoke.mockClear();
  });

  it('renders port rates and selects one through the inbox channel', async () => {
    expect(host.textContent).toContain('CMA');
    expect(host.textContent).toContain('USD 1,800');
    const row = Array.from(host.querySelectorAll<HTMLElement>('.inbox-quote-port')).find(item => item.textContent?.includes('CMA'))!;
    const candidate = row.querySelector<HTMLButtonElement>('button')!;
    await act(async () => candidate.click());
    expect(invoke).toHaveBeenCalledWith('inbox:quoteSelect', { messageId: 7, candidateId: 'rate-1' });
  });

  it('submits edited route fields for requery', async () => {
    const edit = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent === '修改')!;
    await act(async () => edit.click());
    const input = host.querySelector<HTMLInputElement>('input[placeholder="POD"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'Itapoa');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const button = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent?.includes('重新核价'))!;
    await act(async () => button.click());
    expect(invoke).toHaveBeenCalledWith('inbox:quoteRequery', expect.objectContaining({ messageId: 7, fields: expect.objectContaining({ pod: 'Itapoa' }) }));
  });
});
