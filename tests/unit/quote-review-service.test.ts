import { describe, expect, it, vi } from 'vitest';
import { createQuoteService } from '../../server/services/quotes';
import type { PostgresQuoteCaseRepository } from '../../server/adapters/postgres/quote-case-repository';
import { success, type Result } from '../../server/core/crm';
import type { QuoteReviewRequest } from '../../server/core/quote-case';

const token = 'a'.repeat(43);
const hash = 'token-hash';
const reviewId = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const tokens = { hash: vi.fn(() => hash) } as unknown as Parameters<typeof createQuoteService>[1];

function buildRepo(overrides: Partial<Record<'listReviews' | 'decideReview', unknown>> = {}) {
  const repo = {
    listReviews: vi.fn(async () => success({ items: [], total: 0 })),
    decideReview: vi.fn(async (): Promise<Result<QuoteReviewRequest>> => success({
      reviewId, quoteId: 'q', requestedBy: 'u1', reviewerUserId: 'u2', status: 'approved',
      reason: null, decisionNote: null, linkedMessageId: null, linkedTaskId: null,
      createdAt: new Date().toISOString(), decidedAt: new Date().toISOString(),
    })),
    ...overrides,
  };
  return repo as unknown as PostgresQuoteCaseRepository & typeof repo;
}

describe('quote review service', () => {
  it('defaults to pending reviews and forwards page arguments', async () => {
    const repo = buildRepo();
    const service = createQuoteService(repo, tokens);
    const result = await service.listReviews(token, {});
    expect(result.ok).toBe(true);
    expect(repo.listReviews).toHaveBeenCalledWith(hash, 'pending', 25, 0);
  });

  it('rejects unknown status and bad pagination before touching the repository', async () => {
    const repo = buildRepo();
    const service = createQuoteService(repo, tokens);
    expect(await service.listReviews(token, { status: 'open' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await service.listReviews(token, { limit: 0 })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(repo.listReviews).not.toHaveBeenCalled();
  });

  it('passes an approval decision with its note to the repository', async () => {
    const repo = buildRepo();
    const service = createQuoteService(repo, tokens);
    const result = await service.decideReview(token, reviewId, { action: 'approve', note: '价格有效' });
    expect(result.ok).toBe(true);
    expect(repo.decideReview).toHaveBeenCalledWith(hash, reviewId, 'approve', '价格有效');
  });

  it('rejects malformed review ids, actions and oversized notes', async () => {
    const repo = buildRepo();
    const service = createQuoteService(repo, tokens);
    expect(await service.decideReview(token, 'not-a-uuid', { action: 'approve' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await service.decideReview(token, reviewId, { action: 'maybe' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await service.decideReview(token, reviewId, { action: 'reject', note: 'x'.repeat(501) })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(repo.decideReview).not.toHaveBeenCalled();
  });
});
