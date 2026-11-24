import { describe, expect, it, vi } from 'vitest';
import { completeInboxTask, completeRepliedTask, openInboxTask, type InboxTaskRef } from '../../src/renderer/pages/inbox/inbox-task-sync';
import { ONLINE_CHANNELS } from '../../src/shared/online-crm';

const ref: InboxTaskRef = { customerId: 'customer-1', contactId: 9, messageKey: 'mail-key-1', threadKey: '报价确认', title: '回复客户询价' };

describe('inbox task synchronization', () => {
  it('creates one center mail task for an email todo', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === ONLINE_CHANNELS.CONTACT_DETAIL) return { ok: true, data: { contact: { customerVersion: 4 } } };
      if (channel === ONLINE_CHANNELS.TASK_CREATE) return { ok: true, data: { taskId: 't1' } };
      return { ok: false };
    });
    expect(await openInboxTask(ref, invoke, Date.parse('2026-11-18T00:00:00Z'))).toBe('created');
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.TASK_CREATE, expect.objectContaining({
      customerId: 'customer-1', title: '回复客户询价', expectedCustomerVersion: 4,
      sourceKind: 'mail_manual', sourceMessageKey: 'mail-key-1', sourceThreadKey: '报价确认',
    }));
  });

  it('skips emails without a center message key', async () => {
    const invoke = vi.fn();
    expect(await openInboxTask({ ...ref, messageKey: '' }, invoke)).toBe('skipped');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('completes the open task tied to the same message', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === ONLINE_CHANNELS.TASK_LIST) return { ok: true, data: { items: [{ taskId: 't1', version: 2, status: 'open', sourceMessageKey: 'mail-key-1' }], total: 1 } };
      if (channel === ONLINE_CHANNELS.TASK_COMPLETE) return { ok: true, data: { taskId: 't1' } };
      return { ok: false };
    });
    expect(await completeInboxTask(ref, invoke)).toBe('completed');
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.TASK_COMPLETE, expect.objectContaining({ taskId: 't1', expectedVersion: 2 }));
  });

  it('does not complete unrelated tasks and treats offline as skipped', async () => {
    const unrelated = vi.fn(async (channel: string) => channel === ONLINE_CHANNELS.TASK_LIST
      ? { ok: true, data: { items: [{ taskId: 't2', version: 1, status: 'open', sourceMessageKey: 'other' }], total: 1 } }
      : { ok: false });
    expect(await completeInboxTask(ref, unrelated)).toBe('skipped');
    const offlineInvoke = vi.fn(async () => ({ success: false, code: 'UNAVAILABLE', error: '当前离线' }));
    expect(await openInboxTask(ref, offlineInvoke)).toBe('skipped');
  });

  it('completes only tasks created before the sent-folder reply', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === ONLINE_CHANNELS.TASK_LIST) return { ok: true, data: { items: [
        { taskId: 'old', version: 1, status: 'open', sourceThreadKey: '报价确认', createdAt: '2026-11-17T00:00:00.000Z' },
        { taskId: 'new', version: 1, status: 'open', sourceThreadKey: '报价确认', createdAt: '2026-11-19T00:00:00.000Z' },
      ], total: 2 } };
      if (channel === ONLINE_CHANNELS.TASK_COMPLETE) return { ok: true, data: { taskId: 'old' } };
      return { ok: false };
    });
    expect(await completeRepliedTask('customer-1', '报价确认', '2026-11-18T00:00:00.000Z', invoke)).toBe('completed');
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.TASK_COMPLETE, expect.objectContaining({ taskId: 'old' }));
    expect(invoke).not.toHaveBeenCalledWith(ONLINE_CHANNELS.TASK_COMPLETE, expect.objectContaining({ taskId: 'new' }));
  });
});
