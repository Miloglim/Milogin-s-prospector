export const INBOX_IMAP_BATCH_LIMIT = 500;
export const INBOX_RECENT_BACKFILL_COUNT = 200;

export interface InboxUidBatch {
  batch: number[];
  remaining: number;
  nextCursor: number | null;
}

export function needsRecentInboxBackfill(localIncomingCount: number): boolean {
  return localIncomingCount < INBOX_RECENT_BACKFILL_COUNT;
}

/** Keeps regular watermark candidates first, then adds missing recent UIDs within the round cap. */
export function mergeInboxScanUids(
  regularUids: readonly number[],
  recentUids: readonly number[],
  limit = INBOX_IMAP_BATCH_LIMIT,
): number[] {
  return [...new Set([...regularUids, ...recentUids])]
    .filter(uid => Number.isSafeInteger(uid) && uid > 0)
    .slice(0, limit);
}

/** Selects the next ascending UID window so a capped round cannot repeatedly starve later mail. */
export function selectInboxUidBatch(
  uids: readonly number[],
  lastUid: number | null,
  limit = INBOX_IMAP_BATCH_LIMIT,
): InboxUidBatch {
  const pending = [...new Set(uids)]
    .filter(uid => Number.isSafeInteger(uid) && uid > 0)
    .filter(uid => lastUid === null || uid > lastUid)
    .sort((left, right) => left - right);
  const batch = pending.slice(0, limit);
  return {
    batch,
    remaining: Math.max(0, pending.length - batch.length),
    nextCursor: batch.length > 0 ? batch[batch.length - 1]! : lastUid,
  };
}
