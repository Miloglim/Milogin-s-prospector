import { describe, expect, it, vi } from 'vitest';
import type { CenterContact } from '../../server/core/center-contacts';
import { runContactIncrementalSync, type ContactIncrementalPage, type ContactIncrementalStore } from '../../src/main/core/contact-incremental-sync';

const ctx = { baseUrl: 'https://center.test', userId: 'alice', permissionKey: 'sales' };
const row = (contactId: number): CenterContact => ({
  contactId, customerId: `customer-${contactId}`, customerVersion: 1, contactVersion: 1,
  companyId: 1, companyName: 'Acme', email: null, firstName: null, lastName: null, title: null,
  phone: null, linkedinUrl: null, country: null, clientType: null, language: null, stage: 'cold', status: '', tags: [], extra: {},
  touchStatus: 'uncontacted', assignee: '', source: 'manual', sourceDetail: null, createdAt: '2026-10-16T00:00:00Z',
  updatedAt: '2026-10-16T00:00:00Z', ownerUserId: 'alice', ownerName: null, origin: 'personal', state: 'owned', assignmentStatus: null,
});

function store(cursor: string | null = 'c0'): ContactIncrementalStore & { upserts: CenterContact[]; removed: Array<{ contactId: number; customerId: string }> } {
  const value = { cursor, permissionKey: 'sales' };
  const result = {
    upserts: [] as CenterContact[], removed: [] as Array<{ contactId: number; customerId: string }>,
    state: vi.fn(() => value),
    upsert: vi.fn((_: typeof ctx, contact: CenterContact) => result.upserts.push(contact)),
    remove: vi.fn((_: typeof ctx, ref: { contactId: number; customerId: string }) => result.removed.push(ref)),
    saveCursor: vi.fn((_: typeof ctx, next: string) => { value.cursor = next; }),
    invalidate: vi.fn(),
  };
  return result;
}

describe('local contact incremental sync adapter', () => {
  it('applies upserts and tombstones before durably advancing the cursor', async () => {
    const target = store();
    const pages: ContactIncrementalPage[] = [
      { baseCursor: 'c0', nextCursor: 'c1', hasMore: true, changes: [{ kind: 'upsert', contact: row(1) }] },
      { baseCursor: 'c1', nextCursor: 'c2', hasMore: false, changes: [{ kind: 'tombstone', contactId: 2, customerId: 'customer-2' }] },
    ];
    const result = await runContactIncrementalSync(ctx, target, async cursor => pages.shift()!, 10);
    expect(result).toEqual({ kind: 'incremental', cursor: 'c2', pages: 2, upserts: 1, tombstones: 1 });
    expect(target.upserts).toHaveLength(1);
    expect(target.removed).toEqual([{ contactId: 2, customerId: 'customer-2' }]);
    expect(target.saveCursor).toHaveBeenCalledTimes(2);
  });

  it('falls back without mutating or advancing when the center does not support the page', async () => {
    const target = store();
    const result = await runContactIncrementalSync(ctx, target, async () => undefined);
    expect(result).toEqual({ kind: 'fallback', reason: 'unsupported' });
    expect(target.saveCursor).not.toHaveBeenCalled();
    expect(target.upsert).not.toHaveBeenCalled();
  });

  it('falls back on resync or permission changes and keeps the previous cursor', async () => {
    const target = store();
    const resync = await runContactIncrementalSync(ctx, target, async () => ({ baseCursor: 'c0', nextCursor: 'c1', hasMore: false, resyncRequired: true, changes: [] }));
    expect(resync).toEqual({ kind: 'fallback', reason: 'resync-required' });
    const changed = await runContactIncrementalSync(ctx, target, async () => ({ baseCursor: 'c0', nextCursor: 'c1', hasMore: false, permissionKey: 'viewer', changes: [] }));
    expect(changed).toEqual({ kind: 'fallback', reason: 'permission-changed' });
    expect(target.saveCursor).not.toHaveBeenCalled();
  });

  it('falls back when a page cursor is out of sequence', async () => {
    const target = store('c7');
    const result = await runContactIncrementalSync(ctx, target, async () => ({ baseCursor: 'c6', nextCursor: 'c8', hasMore: false, changes: [] }));
    expect(result).toEqual({ kind: 'fallback', reason: 'cursor-mismatch' });
    expect(target.invalidate).toHaveBeenCalledWith(ctx);
  });

  it('does not advance the cursor when applying a change fails', async () => {
    const target = store();
    target.upsert.mockImplementation(() => { throw new Error('local write failed'); });
    await expect(runContactIncrementalSync(ctx, target, async () => ({ baseCursor: 'c0', nextCursor: 'c1', hasMore: false, changes: [{ kind: 'upsert', contact: row(3) }] }))).rejects.toThrow('local write failed');
    expect(target.saveCursor).not.toHaveBeenCalled();
  });
});
