import { and, desc, eq, gt } from 'drizzle-orm';
import { getDb } from '../db';
import { inboxMessages } from '../db/schema/inbox';
import { emailAccounts } from '../db/schema/accounts';
import type { MailboxSnapshot } from '../services/inbox-center-contact.service';

export const MAILBOX_RECONCILE_PAGE = 100;
export const MAILBOX_RECONCILE_MAX = 500;
export interface MailboxSnapshotQuery { afterId?: number; limit?: number; accountId?: number }
function querySnapshots() {
  return getDb().select({
    id: inboxMessages.id, accountId: inboxMessages.accountId, accountEmail: emailAccounts.email,
    messageId: inboxMessages.messageId, fromEmail: inboxMessages.fromEmail, to: inboxMessages.to,
    cc: inboxMessages.cc, subject: inboxMessages.subject, bodyPreview: inboxMessages.bodyPreview,
    receivedAt: inboxMessages.receivedAt, classification: inboxMessages.classification, myRole: inboxMessages.myRole,
  }).from(inboxMessages).innerJoin(emailAccounts, eq(emailAccounts.id, inboxMessages.accountId));
}
/** Local mailbox metadata only: credentials, HTML bodies and attachments never enter the mirror. */
export function readMailboxSnapshot(id: number): MailboxSnapshot | null {
  return querySnapshots().where(eq(inboxMessages.id, id)).get() || null;
}
export function latestMailboxId(): number {
  return getDb().select({ id: inboxMessages.id }).from(inboxMessages).orderBy(desc(inboxMessages.id)).limit(1).get()?.id ?? 0;
}
export function readMailboxSnapshots(input: MailboxSnapshotQuery = {}): { items: MailboxSnapshot[]; nextAfterId: number; hasMore: boolean } {
  const limit = Math.min(Math.max(input.limit ?? MAILBOX_RECONCILE_PAGE, 1), MAILBOX_RECONCILE_MAX);
  const rows = querySnapshots().where(and(gt(inboxMessages.id, input.afterId ?? 0), input.accountId ? eq(inboxMessages.accountId, input.accountId) : undefined))
    .orderBy(inboxMessages.id).limit(limit + 1).all();
  const items = rows.slice(0, limit);
  return { items, nextAfterId: items.at(-1)?.id ?? input.afterId ?? 0, hasMore: rows.length > limit };
}
