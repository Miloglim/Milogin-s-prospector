import { describe, expect, it, vi } from 'vitest';
import { importAgentContacts, readAgentReminders } from '../../src/main/services/agent-crm-tools.service';
import type { AgentContactPort } from '../../src/main/services/agent-contact.service';
import { failure, success } from '../../server/core/crm';
import type { ImportRequest } from '../../server/core/leads';
import type { FollowupTask } from '../../server/core/tasks';

function fixture() {
  let active = true;
  const requests: ImportRequest[] = [];
  const port: AgentContactPort = {
    snapshot: () => success({ scope: 'A', active: () => active, contacts: [] }),
    update: vi.fn(), followup: vi.fn(), createKey: () => crypto.randomUUID(),
    now: () => new Date('2026-10-15T12:00:00+08:00').getTime(), report: vi.fn(),
    importRows: vi.fn(async input => {
      requests.push(input);
      return success({ batchId: 'batch', version: 1, rows: input.rows.map((_, index) => ({ rowId: String(index), index, status: 'created' as const, customerId: 'customer' })) });
    }),
    tasks: vi.fn(async () => success({ items: [], total: 0 })),
  };
  return { port, requests, switchAccount: () => { active = false; } };
}
const input = [{ email: ' A@Example.test ', name: 'Ana Silva', company: 'ACME', note: 'source note', stage: 'f1' }];

describe('remaining center Agent entrypoints', () => {
  it('normalizes fields, preserves source notes and avoids client-chosen identity', async () => {
    const { port, requests } = fixture();
    expect(await importAgentContacts(port, 'chat', input)).toMatchObject({ ok: true, data: { imported: 1, invalidCount: 0, notesArchived: 1 } });
    expect(requests[0]).toMatchObject({ source: 'agent', rows: [{ email: 'a@example.test', firstName: 'Ana', lastName: 'Silva', companyName: 'ACME', stage: 'f1', rawRow: { note: 'source note' } }] });
    expect(requests[0].kind).toBeUndefined();
  });
  it('never invents company data and deduplicates normalized email within a batch', async () => {
    const { port, requests } = fixture();
    expect(await importAgentContacts(port, 'chat', [...input, ...input, { email: 'b@c.test' }])).toMatchObject({ ok: true, data: { imported: 1, invalidCount: 1, skippedInputDuplicates: 1 } });
    expect(requests[0].rows).toHaveLength(1);
  });
  it('keeps contacts from the same company in one customer within a batch', async () => {
    const { port, requests } = fixture();
    await importAgentContacts(port, 'chat', [...input, { ...input[0], email: 'second@example.test' }]);
    expect(requests[0].rows[0].customerKey).toBe(requests[0].rows[1].customerKey);
  });
  it('coalesces concurrent imports into one request', async () => {
    const { port } = fixture();
    await Promise.all([importAgentContacts(port, 'chat', input), importAgentContacts(port, 'chat', input)]);
    expect(port.importRows).toHaveBeenCalledTimes(1);
  });
  it('bounds reminder scanning and marks changed or incomplete pages', async () => {
    const { port } = fixture();
    vi.mocked(port.tasks!).mockResolvedValue(success({ items: [], total: 1 }));
    expect(await readAgentReminders(port)).toMatchObject({ ok: true, data: { partial: true, scanned: 0, totalOpenTasks: 1 } });
    expect(port.tasks).toHaveBeenCalledTimes(1);
  });
  it('freezes key and body across an unknown outcome and suppresses duplicate submits', async () => {
    const { port } = fixture();
    vi.mocked(port.importRows!).mockResolvedValueOnce(failure('UNAVAILABLE', 'unknown'));
    await importAgentContacts(port, 'chat', input);
    const original = vi.mocked(port.importRows!).mock.calls[0][0];
    await importAgentContacts(port, 'chat', input);
    await importAgentContacts(port, 'chat', input);
    expect(port.importRows).toHaveBeenCalledTimes(2);
    expect(vi.mocked(port.importRows!).mock.calls[1][0]).toEqual(original);
  });
  it('does not leak a response after switching accounts', async () => {
    const { port, switchAccount } = fixture();
    vi.mocked(port.importRows!).mockImplementation(async () => { switchAccount(); return success({ batchId: 'b', version: 1, rows: [{ index: 0, rowId: 'r', status: 'created', customerId: 'c' }] }); });
    expect(await importAgentContacts(port, 'chat', input)).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
  });
  it('reports restricted conflicts separately and rejects incomplete receipts', async () => {
    const { port } = fixture();
    vi.mocked(port.importRows!).mockResolvedValueOnce(success({ batchId: 'b', version: 1, rows: [{ index: 0, rowId: 'r', status: 'restricted_conflict' }] }));
    expect(await importAgentContacts(port, 'chat', input)).toMatchObject({ ok: true, data: { imported: 0, conflicts: 1 } });
    vi.mocked(port.importRows!).mockResolvedValueOnce(success({ batchId: 'b', version: 1, rows: [] }));
    expect(await importAgentContacts(port, 'other-chat', input)).toMatchObject({ ok: false, error: { code: 'DATABASE_ERROR' } });
  });
  it('rejects oversized batches before writing and missing adapters without a legacy fallback', async () => {
    const { port } = fixture();
    expect(await importAgentContacts(port, 'chat', Array.from({ length: 201 }, () => input[0]))).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(port.importRows).not.toHaveBeenCalled();
    port.importRows = undefined;
    expect(await importAgentContacts(port, 'chat', input)).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
  });
  it('paginates real open tasks, separates overdue/today and excludes tomorrow', async () => {
    const { port } = fixture();
    const task = (id: string, dueAt: string): FollowupTask => ({ taskId: id, customerId: 'c', title: id, dueAt, status: 'open', version: 1, responsibleUserId: 'u', responsibleName: 'User', createdBy: 'u', createdAt: dueAt, updatedAt: dueAt, completedAt: null, completedBy: null, feedback: null, canManage: true });
    const tasks = [task('old', '2026-10-14T12:00:00+08:00'), task('today', '2026-10-15T23:00:00+08:00'), task('future', '2026-10-16T12:00:00+08:00')];
    vi.mocked(port.tasks!).mockImplementation(async q => success({ items: tasks.slice(q.offset, q.offset + 1), total: tasks.length }));
    expect(await readAgentReminders(port)).toMatchObject({ ok: true, data: { source: 'center_tasks', dueCount: 1, overdueCount: 1, partial: false, overdue: [{ taskId: 'old' }], due: [{ taskId: 'today' }] } });
    expect(port.tasks).toHaveBeenCalledTimes(3);
  });
  it('does not turn an offline failure or changed account into an empty reminder list', async () => {
    const { port, switchAccount } = fixture();
    vi.mocked(port.tasks!).mockResolvedValueOnce(failure('UNAVAILABLE', 'offline'));
    expect(await readAgentReminders(port)).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
    vi.mocked(port.tasks!).mockImplementation(async () => { switchAccount(); return success({ items: [], total: 0 }); });
    expect(await readAgentReminders(port)).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
  });
});
