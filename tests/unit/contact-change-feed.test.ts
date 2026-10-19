import { describe, expect, it } from 'vitest';
import { contactChangeQuery } from '../../server/core/contact-change-feed';
import { createContactChangeService } from '../../server/services/contact-change-feed';

describe('contact change feed contract', () => {
  it('rejects malformed and unsafe cursors before repository access', async () => {
    const repo = { feed: () => { throw new Error('repository must not run'); } } as never;
    const service = createContactChangeService(repo, { hash: (v: string) => v, create: () => '' });
    expect(contactChangeQuery({ after: '-1', limit: 50 }).ok).toBe(false);
    expect((await service.feed('short', { after: '0', limit: 50 })).ok).toBe(false);
  });
  it('allows a bounded page and preserves repository result', async () => {
    const repo = { feed: async (_hash: string, query: { after: string; limit: number }) => ({ ok: true as const, data: { items: [], nextCursor: query.after, hasMore: false } }) };
    const result = await createContactChangeService(repo, { hash: (v: string) => `h:${v}`, create: () => '' }).feed('A'.repeat(43), { after: '3', limit: 2 });
    expect(result).toEqual({ ok: true, data: { items: [], nextCursor: '3', hasMore: false } });
  });
});
