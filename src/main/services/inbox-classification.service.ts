import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq } from 'drizzle-orm';
import { getDb } from '../db';
import { inboxClassificationChanges, inboxMessages } from '../db/schema/inbox';
import { okResult, failResult, type Result } from '../errors';
import { Log } from '../logger';
import { matchCenterMailboxMessage, type InboxCenterContactPort, type MailboxSnapshot } from './inbox-center-contact.service';

const running = new Map<string, Promise<Result<void>>>();
const centerScope = (context: { baseUrl: string; userId: string }) => JSON.stringify([context.baseUrl, context.userId]);
const messageStream = (source: MailboxSnapshot) => JSON.stringify([
  source.accountEmail.trim().toLowerCase(), source.messageId?.trim() || `${source.folder || 'inbox'}:${source.uid ?? source.id}`,
]);

export function latestInboxClassificationChange(port: InboxCenterContactPort, id: number): string | undefined {
  const context = port.context();
  if (!context) return undefined;
  return getDb().select({ key: inboxClassificationChanges.changeKey }).from(inboxClassificationChanges)
    .where(and(eq(inboxClassificationChanges.centerScope, centerScope(context)), eq(inboxClassificationChanges.messageId, id)))
    .orderBy(desc(inboxClassificationChanges.id)).limit(1).get()?.key;
}

/** The local classification and its immutable intent commit together before asynchronous matching. */
export function recordInboxClassificationChange(port: InboxCenterContactPort, source: MailboxSnapshot): Result<void> {
  const context = port.context();
  if (!context || context.active?.() === false) return failResult('账号已变化');
  try {
    getDb().transaction(transaction => {
      transaction.insert(inboxClassificationChanges).values({
        changeKey: randomUUID(), centerScope: centerScope(context), messageId: source.id, sourceJson: JSON.stringify(source),
      }).run();
      transaction.update(inboxMessages).set({ classification: source.classification }).where(eq(inboxMessages.id, source.id)).run();
    });
    return okResult(undefined);
  } catch (error) {
    Log.error('inbox.classification', '分类更正未保存', error instanceof Error ? error.stack : undefined);
    return failResult('分类更正未保存');
  }
}

/** Preserve journal order per message across rapid edits, disconnection and process restarts. */
export function replayInboxClassificationChanges(port: InboxCenterContactPort): Promise<Result<void>> {
  const context = port.context();
  if (!context) return Promise.resolve(failResult('当前账号无法同步邮件分类'));
  const scope = centerScope(context);
  const pending = running.get(scope);
  if (pending) return pending;
  const active = () => {
    const current = port.context();
    return context.active?.() !== false && !!current && current.active?.() !== false && centerScope(current) === scope;
  };
  const database = getDb();
  const job = (async (): Promise<Result<void>> => {
    try {
      const blockedStreams = new Set<string>();
      let blockedMessage = '';
      while (active()) {
        const changes = database.select().from(inboxClassificationChanges)
          .where(and(eq(inboxClassificationChanges.centerScope, scope), eq(inboxClassificationChanges.status, 'pending')))
          .orderBy(asc(inboxClassificationChanges.id)).all();
        const change = changes.find(change => !blockedStreams.has(messageStream(JSON.parse(change.sourceJson) as MailboxSnapshot)));
        if (!change) return blockedStreams.size ? failResult(blockedMessage || '邮件分类已保存，部分邮件等待联系人关联后同步') : okResult(undefined);
        const source = JSON.parse(change.sourceJson) as MailboxSnapshot;
        const result = await matchCenterMailboxMessage(port, source, { correctionChangeKey: change.changeKey });
        if (!active()) return failResult('账号已变化，邮件分类同步已停止');
        if (!result.success || !result.data.matched) {
          // Keep this stream's sequence intact while allowing unrelated messages to progress.
          if (!result.success) blockedMessage = result.error;
          blockedStreams.add(messageStream(source));
          continue;
        }
        database.update(inboxClassificationChanges).set({ status: 'queued' }).where(eq(inboxClassificationChanges.id, change.id)).run();
      }
      return failResult('账号已变化，邮件分类同步已停止');
    } catch (error) {
      Log.error('inbox.classification', '分类更正等待重新同步', error instanceof Error ? error.stack : undefined);
      return failResult('邮件分类等待重新同步');
    }
  })().finally(() => { if (running.get(scope) === job) running.delete(scope); });
  running.set(scope, job);
  return job;
}
