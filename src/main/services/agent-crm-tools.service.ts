import { failure, success } from '../../../server/core/crm';
import { LEAD_LIMITS, importRowIssue, type ImportRequest, type ImportReceipt } from '../../../server/core/leads';
import { TASK_LIMITS, type FollowupTask } from '../../../server/core/tasks';
import type { Result } from '../../shared/online-crm';
import { normStage, AGENT_CONTACT_LIMITS } from '../core/agent-contact';
import type { AgentContactPort } from './agent-contact.service';

export interface AgentImportContact {
  email: string; name?: string | null; company?: string | null; country?: string | null;
  title?: string | null; phone?: string | null; stage?: string | null; note?: string | null;
}
interface ImportSummary {
  batchId: string; imported: number; duplicates: number; conflicts: number; invalidCount: number;
  skippedInputDuplicates: number; notesArchived: number; noteStorage: 'import_source_only';
  rows: ImportReceipt['rows'];
}
interface ImportEntry {
  request: ImportRequest; invalid: number; duplicates: number; notes: number;
  pending?: Promise<Result<ImportSummary>>; result?: Result<ImportSummary>; completedAt?: number;
}
const imports = new WeakMap<AgentContactPort, Map<string, ImportEntry>>();
const LIMITS = { taskPages: 10 } as const;

/** Center assigns origin/ownership. Notes remain source evidence, never fabricated followups. */
export async function importAgentContacts(port: AgentContactPort, conversationId: string, contacts: AgentImportContact[]): Promise<Result<ImportSummary>> {
  if (!port.importRows) return failure('UNAVAILABLE', '中心导入暂不可用');
  const snapshot = port.snapshot();
  if (!snapshot.ok) return snapshot;
  const captured = snapshot.data;
  if (!captured.active()) return failure('UNAUTHORIZED', '账号或权限已变化');
  if (!contacts.length || contacts.length > LEAD_LIMITS.batchRows) return failure('INVALID_INPUT', `每次导入1至${LEAD_LIMITS.batchRows}位联系人`);
  const signature = JSON.stringify([captured.scope, conversationId, contacts]);
  let cache = imports.get(port);
  if (!cache) { cache = new Map(); imports.set(port, cache); }
  for (const [key, old] of cache) if (old.completedAt !== undefined && port.now() - old.completedAt > AGENT_CONTACT_LIMITS.duplicateWindowMs) cache.delete(key);
  let entry = cache.get(signature);
  if (!entry) {
    if (cache.size >= AGENT_CONTACT_LIMITS.recentWrites) return failure('UNAVAILABLE', '待确认导入过多，请稍后重试');
    const request: ImportRequest = { source: 'agent', sourceDetail: 'AI联系人导入', idempotencyKey: port.createKey(), rows: [] };
    const emails = new Set<string>();
    const companies = new Map<string, string>();
    let invalid = 0, duplicates = 0, notes = 0;
    for (const contact of contacts) {
      const email = contact.email.trim().toLowerCase();
      const name = (contact.name ?? '').trim();
      const [firstName, ...last] = name.split(/\s+/);
      const stage = normStage(contact.stage);
      const row = { customerKey: port.createKey(), companyName: (contact.company ?? '').trim(), email,
        firstName, lastName: last.join(' '), country: (contact.country ?? '').trim(),
        title: (contact.title ?? '').trim(), phone: (contact.phone ?? '').trim(), stage: stage ?? 'cold',
        rawRow: { name, email, company: contact.company ?? '', note: contact.note ?? '' } };
      if (stage === undefined || importRowIssue(row) || (contact.note?.length ?? 0) > LEAD_LIMITS.note) { invalid++; continue; }
      if (emails.has(email)) { duplicates++; continue; }
      const companyKey = JSON.stringify([row.companyName, row.country]);
      row.customerKey = companies.get(companyKey) ?? row.customerKey;
      companies.set(companyKey, row.customerKey);
      emails.add(email); request.rows.push(row);
      if (contact.note?.trim()) notes++;
    }
    if (!request.rows.length) return failure('INVALID_INPUT', '没有有效联系人，请核对邮箱、公司名称和阶段');
    entry = { request, invalid, duplicates, notes }; cache.set(signature, entry);
  }
  if (entry.result) return entry.result;
  if (!entry.pending) {
    const current = entry;
    current.pending = (async () => {
      let result: Result<ImportSummary>;
      try {
        if (!captured.active()) return failure('UNAUTHORIZED', '账号或权限已变化');
        const receipt = await port.importRows!(current.request);
        if (!captured.active()) return failure('UNAUTHORIZED', '账号或权限已变化');
        if (!receipt.ok) result = receipt;
        else {
          const rows = receipt.data.rows;
          const statuses = ['created', 'duplicate', 'invalid', 'restricted_conflict'];
          if (!Array.isArray(rows) || rows.length !== current.request.rows.length || new Set(rows.map(row => row.index)).size !== rows.length || rows.some(row => !Number.isInteger(row.index) || row.index < 0 || row.index >= rows.length || !statuses.includes(row.status) || row.status === 'created' && !row.customerId)) {
            result = failure('DATABASE_ERROR', '中心导入回执不完整，请重试确认结果');
          } else result = success({ batchId: receipt.data.batchId, imported: rows.filter(row => row.status === 'created').length,
            duplicates: rows.filter(row => row.status === 'duplicate').length, conflicts: rows.filter(row => row.status === 'restricted_conflict').length,
            invalidCount: current.invalid + rows.filter(row => row.status === 'invalid').length, skippedInputDuplicates: current.duplicates,
            notesArchived: current.notes, noteStorage: 'import_source_only', rows });
        }
      } catch (error) { port.report(error); result = failure('UNAVAILABLE', '中心未确认导入结果，请重试核对'); }
      if (result.ok) { current.result = result; current.completedAt = port.now(); }
      else if (!['UNAVAILABLE', 'DATABASE_ERROR'].includes(result.error.code)) cache!.delete(signature);
      return result;
    })().finally(() => { current.pending = undefined; });
  }
  const result = await entry.pending!;
  return captured.active() ? result : failure('UNAUTHORIZED', '账号或权限已变化');
}

/** Tasks retain customer/task IDs; these must never be used as legacy contact IDs. */
export async function readAgentReminders(port: AgentContactPort) {
  if (!port.tasks) return failure('UNAVAILABLE', '中心跟进任务暂不可用');
  const snapshot = port.snapshot();
  if (!snapshot.ok) return snapshot;
  const captured = snapshot.data;
  if (!captured.active()) return failure('UNAUTHORIZED', '账号或权限已变化');
  const tasks = new Map<string, FollowupTask>();
  let offset = 0, total = 0, complete = false, changed = false;
  try {
    for (let page = 0; page < LIMITS.taskPages; page++) {
      if (!captured.active()) return failure('UNAUTHORIZED', '账号或权限已变化');
      const result = await port.tasks({ status: 'open', limit: TASK_LIMITS.pageMax, offset });
      if (!captured.active()) return failure('UNAUTHORIZED', '账号或权限已变化');
      if (!result.ok) return result;
      if (page > 0 && result.data.total !== total) changed = true;
      total = result.data.total;
      result.data.items.forEach(task => tasks.set(task.taskId, task));
      offset += result.data.items.length;
      if (offset >= total) { complete = true; break; }
      if (!result.data.items.length) break;
    }
    const today = new Date(port.now()); today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    const rows = [...tasks.values()].filter(task => task.status === 'open' && Number.isFinite(Date.parse(task.dueAt)) && Date.parse(task.dueAt) < tomorrow.getTime())
      .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt) || a.taskId.localeCompare(b.taskId));
    const overdue = rows.filter(task => Date.parse(task.dueAt) < today.getTime());
    const due = rows.filter(task => Date.parse(task.dueAt) >= today.getTime());
    return success({ source: 'center_tasks' as const, scope: 'authorized' as const, dueCount: due.length, overdueCount: overdue.length,
      due, overdue, partial: !complete || changed || tasks.size !== total, scanned: tasks.size, totalOpenTasks: total });
  } catch (error) { port.report(error); return failure('UNAVAILABLE', '中心跟进任务暂时无法读取'); }
}
