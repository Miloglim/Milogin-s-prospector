import type { CenterContact } from '../../../server/core/center-contacts';
import type { ContactMirrorContext } from './contact-mirror';

/** Internal shape only. The center endpoint is intentionally not defined here. */
export type ContactIncrementalChange =
  | { kind: 'upsert'; contact: CenterContact }
  | { kind: 'tombstone'; contactId: number; customerId: string };

/** A center adapter may implement this shape when a cursor protocol is available. */
export interface ContactIncrementalPage {
  baseCursor: string | null;
  nextCursor: string;
  hasMore: boolean;
  changes: ContactIncrementalChange[];
  permissionKey?: string;
  resyncRequired?: boolean;
}

export interface ContactIncrementalState { cursor: string | null; permissionKey: string; }
export interface ContactIncrementalStore {
  state(context: ContactMirrorContext): ContactIncrementalState;
  upsert(context: ContactMirrorContext, contact: CenterContact): void;
  upsertMany?(context: ContactMirrorContext, contacts: CenterContact[]): void;
  remove(context: ContactMirrorContext, reference: { contactId: number; customerId: string }): void;
  saveCursor(context: ContactMirrorContext, cursor: string): void;
  invalidate(context: ContactMirrorContext): void;
}
export type ContactIncrementalResult =
  | { kind: 'incremental'; cursor: string; pages: number; upserts: number; tombstones: number }
  | { kind: 'fallback'; reason: 'unsupported' | 'resync-required' | 'permission-changed' | 'cursor-mismatch' };
const DEFAULT_MAX_PAGES = 100;

/**
 * Applies a complete cursor page atomically from the caller's perspective: the
 * cursor is saved only after every upsert/tombstone in that page succeeds.
 * The caller can use `fallback` to invoke the existing full authorized scan.
 */
export async function runContactIncrementalSync(
  context: ContactMirrorContext,
  store: ContactIncrementalStore,
  fetchPage: (cursor: string | null) => Promise<ContactIncrementalPage | undefined>,
  maxPages = DEFAULT_MAX_PAGES,
): Promise<ContactIncrementalResult> {
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new Error('增量同步页数上限无效');
  const initial = store.state(context);
  if (initial.permissionKey !== (context.permissionKey ?? '')) return { kind: 'fallback', reason: 'permission-changed' };
  let cursor = initial.cursor, pages = 0, upserts = 0, tombstones = 0;
  while (pages < maxPages) {
    const page = await fetchPage(cursor);
    if (!page) return pages ? { kind: 'incremental', cursor: cursor ?? '', pages, upserts, tombstones } : { kind: 'fallback', reason: 'unsupported' };
    if (page.resyncRequired) return { kind: 'fallback', reason: 'resync-required' };
    if (page.permissionKey !== undefined && page.permissionKey !== (context.permissionKey ?? '')) return { kind: 'fallback', reason: 'permission-changed' };
    if (page.baseCursor !== cursor) { store.invalidate(context); return { kind: 'fallback', reason: 'cursor-mismatch' }; }
    const incoming = page.changes.flatMap(change => change.kind === 'upsert' ? [change.contact] : []);
    if (incoming.length) {
      if (store.upsertMany) store.upsertMany(context, incoming);
      else for (const contact of incoming) store.upsert(context, contact);
      upserts += incoming.length;
    }
    for (const change of page.changes) {
      if (change.kind !== 'tombstone') continue;
      store.remove(context, { contactId: change.contactId, customerId: change.customerId });
      tombstones++;
    }
    store.saveCursor(context, page.nextCursor);
    cursor = page.nextCursor; pages++;
    if (!page.hasMore) return { kind: 'incremental', cursor, pages, upserts, tombstones };
  }
  return { kind: 'fallback', reason: 'resync-required' };
}
