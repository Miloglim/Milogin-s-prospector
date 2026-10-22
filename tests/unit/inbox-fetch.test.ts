import { describe, expect, it } from "vitest";
import { INBOX_IMAP_BATCH_LIMIT, INBOX_RECENT_BACKFILL_COUNT, mergeInboxScanUids, needsRecentInboxBackfill, selectInboxUidBatch } from "../../src/main/core/inbox-fetch";

describe("IMAP UID batching", () => {
  it("continues after the persisted UID instead of selecting the same first batch", () => {
    const uids = Array.from({ length: INBOX_IMAP_BATCH_LIMIT + 3 }, (_, index) => index + 1);
    const first = selectInboxUidBatch(uids, null);
    expect(first.batch[0]).toBe(1);
    expect(first.batch).toHaveLength(INBOX_IMAP_BATCH_LIMIT);
    expect(first.remaining).toBe(3);

    const second = selectInboxUidBatch(uids, first.nextCursor);
    expect(second.batch).toEqual([501, 502, 503]);
    expect(second.remaining).toBe(0);
    expect(second.nextCursor).toBe(503);
  });

  it("deduplicates and ignores invalid or non-ascending server values", () => {
    expect(selectInboxUidBatch([9, 2, 9, -1, 0, Number.NaN, 5], 2, 10)).toMatchObject({
      batch: [5, 9],
      remaining: 0,
      nextCursor: 9,
    });
  });

  it("requires a recent-200 backfill until the local incoming mailbox reaches 200", () => {
    expect(needsRecentInboxBackfill(0)).toBe(true);
    expect(needsRecentInboxBackfill(INBOX_RECENT_BACKFILL_COUNT - 1)).toBe(true);
    expect(needsRecentInboxBackfill(INBOX_RECENT_BACKFILL_COUNT)).toBe(false);
  });

  it("merges regular and latest-200 candidates without exceeding the round cap", () => {
    expect(mergeInboxScanUids([50, 51], [1, 2, 50, 51, 52], 10)).toEqual([50, 51, 1, 2, 52]);
    expect(mergeInboxScanUids(Array.from({ length: 500 }, (_, i) => i + 1000), [1, 2, 3])).toHaveLength(INBOX_IMAP_BATCH_LIMIT);
  });
});
