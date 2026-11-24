// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QuoteReviewQueue } from '../../src/renderer/pages/team/QuoteReviewQueue';
import type { QuoteReviewPage } from '../../src/shared/online-crm';

const review = {
  reviewId: '11111111-2222-4333-8444-555555555555',
  quoteId: 'quote-1',
  requestedBy: 'sales-user',
  reviewerUserId: 'leader-user',
  status: 'pending' as const,
  reason: '核对运价有效期',
  decisionNote: null,
  linkedMessageId: 'message-1',
  linkedTaskId: null,
  createdAt: '2026-11-18T01:00:00.000Z',
  decidedAt: null,
  quoteCaseId: 'quote-case-1',
  caseId: 'case-1',
  requestedByName: '林销售',
  customerName: 'Acme Logistics',
  subject: 'Shanghai to Santos',
  selectedCandidate: {
    id: 'rate-1', carrier: 'CMA', pol: 'Shanghai', pod: 'Santos', containerType: '40HQ',
    price: 1800, currency: 'USD', etd: null, validFrom: null, validTo: '2026-12-15',
    sourceUpdatedAt: null, evidence: [],
  },
  candidates: [],
};

describe('quote review queue', () => {
  let root: Root;
  let host: HTMLDivElement;
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'online:quote-review-list') return { ok: true, data: { items: [review], total: 1 } as QuoteReviewPage };
    if (channel === 'online:quote-review-decide') return { ok: true, data: { ...review, status: 'approved' } };
    return { ok: true, data: null };
  });

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
    Object.defineProperty(window, 'api', { configurable: true, value: { invoke, on: vi.fn(() => vi.fn()) } });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<QuoteReviewQueue enabled />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    invoke.mockClear();
  });

  it('lists pending reviews with customer, lane and price', () => {
    expect(host.textContent).toContain('Acme Logistics');
    expect(host.textContent).toContain('CMA');
    expect(host.textContent).toContain('USD 1,800');
    expect(invoke).toHaveBeenCalledWith('online:quote-review-list', { status: 'pending', limit: 20, offset: 0 });
  });

  it('approves a review and notifies the requester', async () => {
    const approve = host.querySelector<HTMLButtonElement>('button.is-approve')!;
    await act(async () => approve.click());
    const confirm = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent?.includes('确认通过'))!;
    await act(async () => confirm.click());
    expect(invoke).toHaveBeenCalledWith('online:quote-review-decide', review.reviewId, { action: 'approve' });
    expect(invoke).toHaveBeenCalledWith('online:team-message-send', expect.objectContaining({ recipientUserId: 'sales-user' }));
    expect(host.textContent).not.toContain('Acme Logistics');
  });
});
