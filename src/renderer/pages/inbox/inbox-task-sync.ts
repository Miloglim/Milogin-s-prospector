import { ONLINE_CHANNELS, type CenterContactDetail, type FollowupTask, type TaskPage } from '../../../shared/online-crm';

export interface InboxTaskRef {
  customerId: string;
  contactId: number;
  messageKey: string;
  threadKey: string;
  title: string;
}

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>;
type CenterResult<T> = { ok?: boolean; data?: T; error?: { message?: string } };
const DAY_MS = 24 * 60 * 60 * 1000;
const offline = (result: unknown): boolean => !!result && typeof result === 'object'
  && ((result as { code?: string }).code === 'UNAVAILABLE' || (result as { error?: { code?: string } }).error?.code === 'UNAVAILABLE');

/** Email todo is a projection of the center follow-up task with the same source message key. */
export async function openInboxTask(ref: InboxTaskRef, invoke: Invoke, now = Date.now()): Promise<'created' | 'skipped' | 'failed'> {
  if (!ref.customerId || !ref.contactId || !ref.messageKey) return 'skipped';
  try {
    const detail = await invoke(ONLINE_CHANNELS.CONTACT_DETAIL, { contactId: ref.contactId, customerId: ref.customerId }) as CenterResult<CenterContactDetail>;
    if (!detail?.ok || !detail.data) return offline(detail) ? 'skipped' : 'failed';
    const result = await invoke(ONLINE_CHANNELS.TASK_CREATE, {
      customerId: ref.customerId,
      title: ref.title.slice(0, 500),
      dueAt: new Date(now + DAY_MS).toISOString(),
      expectedCustomerVersion: detail.data.contact.customerVersion,
      sourceKind: 'mail_manual',
      sourceMessageKey: ref.messageKey,
      sourceThreadKey: ref.threadKey,
      idempotencyKey: crypto.randomUUID(),
    }) as CenterResult<FollowupTask>;
    return result?.ok ? 'created' : offline(result) ? 'skipped' : 'failed';
  } catch { return 'failed'; }
}

export async function completeInboxTask(ref: InboxTaskRef, invoke: Invoke): Promise<'completed' | 'skipped' | 'failed'> {
  if (!ref.customerId || !ref.messageKey) return 'skipped';
  try {
    const page = await invoke(ONLINE_CHANNELS.TASK_LIST, { customerId: ref.customerId, status: 'open', limit: 100, offset: 0 }) as CenterResult<TaskPage>;
    if (!page?.ok || !page.data) return offline(page) ? 'skipped' : 'failed';
    const task = page.data.items.find(item => item.status === 'open' && item.sourceMessageKey === ref.messageKey);
    if (!task) return 'skipped';
    const result = await invoke(ONLINE_CHANNELS.TASK_COMPLETE, {
      taskId: task.taskId,
      expectedVersion: task.version,
      idempotencyKey: crypto.randomUUID(),
      feedback: '邮件待办已处理',
    }) as CenterResult<FollowupTask>;
    return result?.ok ? 'completed' : offline(result) ? 'skipped' : 'failed';
  } catch { return 'failed'; }
}

/** A sent-folder copy with the same normalized subject confirms the reply happened. */
export async function completeRepliedTask(customerId: string, threadKey: string, sentAt: string, invoke: Invoke): Promise<'completed' | 'skipped' | 'failed'> {
  if (!customerId || !threadKey || !sentAt) return 'skipped';
  const sentTime = Date.parse(sentAt);
  if (!Number.isFinite(sentTime)) return 'skipped';
  try {
    const page = await invoke(ONLINE_CHANNELS.TASK_LIST, { customerId, status: 'open', limit: 100, offset: 0 }) as CenterResult<TaskPage>;
    if (!page?.ok || !page.data) return offline(page) ? 'skipped' : 'failed';
    const tasks = page.data.items.filter(item => item.status === 'open' && item.sourceThreadKey === threadKey && Date.parse(item.createdAt) <= sentTime);
    if (!tasks.length) return 'skipped';
    for (const task of tasks) {
      const result = await invoke(ONLINE_CHANNELS.TASK_COMPLETE, {
        taskId: task.taskId, expectedVersion: task.version,
        idempotencyKey: crypto.randomUUID(), feedback: '已从已发送邮件确认回复',
      }) as CenterResult<FollowupTask>;
      if (!result?.ok && !offline(result)) return 'failed';
    }
    return 'completed';
  } catch { return 'failed'; }
}
