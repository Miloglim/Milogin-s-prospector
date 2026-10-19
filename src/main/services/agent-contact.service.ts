import { canEditContactFields } from '../core/contact-permissions';
import type { CenterContact, CenterContactDetail, CenterContactFollowup, CenterContactUpdate, ImportRequest, ImportReceipt, TaskQuery, TaskPage, Result } from '../../shared/online-crm';
import { CONTACT_ASSIGNMENT_LIMITS } from '../../shared/online-crm';
import { failure } from '../../../server/core/crm';
import { AGENT_CONTACT_LIMITS, resolveCenterContacts, type AgentContactTarget } from '../core/agent-contact';

export interface AgentContactSnapshot {
  scope: string;
  active(): boolean;
  contacts: CenterContact[];
  notes?: Array<{ contactId: number; customerId: string; note: string }>;
}
/** Main-process adapter owns identity, storage, HTTP, time, and request keys. */
export interface AgentContactPort {
  snapshot(): Result<AgentContactSnapshot>;
  update(input: CenterContactUpdate): Promise<Result<CenterContactDetail>>;
  followup(input: CenterContactFollowup): Promise<Result<CenterContactDetail>>;
  importRows?(input: ImportRequest): Promise<Result<ImportReceipt>>;
  tasks?(input: TaskQuery): Promise<Result<TaskPage>>;
  createKey(): string;
  now(): number;
  report(error: unknown): void;
}
export interface AgentContactMutation extends AgentContactTarget {
  note?: string;
  title?: string | null;
  phone?: string | null;
  country?: string | null;
  clientType?: string | null;
  tags?: string | null;
  preference?: string | null;
}
type Receipt = Result<CenterContactDetail>;
interface PendingWrite {
  contactId: number;
  customerId: string;
  run(): Promise<Receipt>;
  pending?: Promise<Receipt>;
  result?: Receipt;
  completedAt?: number;
}
let port: AgentContactPort | null = null;
const writes = new WeakMap<AgentContactPort, Map<string, PendingWrite>>();
export function setAgentContactPort(value: AgentContactPort | null): void { port = value; }
export function getAgentContactPort(): AgentContactPort | null { return port; }

/** Freeze key, fields, and version before sending. Unknown outcomes retain the exact request in this runtime. */
export async function mutateAgentContact(
  adapter: AgentContactPort, conversationId: string, action: 'update' | 'followup', args: AgentContactMutation,
): Promise<Receipt> {
  const snapshot = adapter.snapshot();
  if (!snapshot.ok) return snapshot;
  const captured = snapshot.data;
  if (!captured.active()) return failure('UNAUTHORIZED', '账号或权限已变化');
  const signature = JSON.stringify([captured.scope, conversationId, action, args]);
  let cache = writes.get(adapter);
  if (!cache) { cache = new Map(); writes.set(adapter, cache); }
  for (const [key, entry] of cache) {
    if (entry.completedAt !== undefined && adapter.now() - entry.completedAt > AGENT_CONTACT_LIMITS.duplicateWindowMs) cache.delete(key);
  }
  let entry = cache.get(signature);
  if (!entry) {
    if (cache.size >= AGENT_CONTACT_LIMITS.recentWrites) return failure('UNAVAILABLE', '待确认操作过多，请稍后重试');
    const matches = resolveCenterContacts(captured.contacts, args);
    if (!matches.length) return failure('NOT_FOUND', '当前联系人中未找到该记录');
    if (matches.length !== 1) return failure('CONFLICT', '匹配到多位联系人，请指定联系人编号');
    const row = matches[0]!;
    if (!(action === 'update' ? row.canEdit : row.canFollowup)) return failure('FORBIDDEN', '没有该联系人的修改权限');
    if (!row.contactVersion) return failure('UNAVAILABLE', '联系人版本尚未同步');
    const reference = { contactId: row.contactId, customerId: row.customerId, expectedVersion: row.contactVersion, idempotencyKey: adapter.createKey() };
    let send: () => Promise<Receipt>;
    if (action === 'followup') {
      if (!args.note?.trim()) return failure('INVALID_INPUT', '请填写跟进记录');
      const input: CenterContactFollowup = { ...reference, method: 'note', note: args.note };
      send = () => adapter.followup(input);
    } else {
      const fields: CenterContactUpdate['fields'] = {};
      for (const key of ['title', 'phone', 'country'] as const) if (args[key] != null) fields[key] = args[key];
      if (args.clientType != null) {
        if (!['agent', 'direct'].includes(args.clientType)) return failure('INVALID_INPUT', '客户类型只能是 agent 或 direct');
        fields.clientType = args.clientType;
      }
      if (args.tags != null) fields.tags = [...new Set(args.tags.split(/[,，]/).map(value => value.trim()).filter(Boolean))];
      if (args.preference != null) {
        const preference = args.preference.trim();
        if (!preference || preference.length > CONTACT_ASSIGNMENT_LIMITS.preferenceText) return failure('INVALID_INPUT', '偏好内容无效');
        const existing = Array.isArray(row.extra.preferences) ? row.extra.preferences.filter((value): value is string => typeof value === 'string') : [];
        fields.preferences = [...new Set([...existing, preference])].slice(-CONTACT_ASSIGNMENT_LIMITS.preferences);
      }
      if (!Object.keys(fields).length) return failure('INVALID_INPUT', '没有要修改的字段');
      if (!canEditContactFields(row, Object.keys(fields))) return failure('FORBIDDEN', '没有所选字段的修改权限');
      const input: CenterContactUpdate = { ...reference, fields };
      send = () => adapter.update(input);
    }
    entry = { contactId: row.contactId, customerId: row.customerId, run: async () => {
      if (!captured.active()) return failure('UNAUTHORIZED', '账号或权限已变化');
      const result = await send();
      if (!captured.active()) return failure('UNAUTHORIZED', '账号或权限已变化，请重新核对操作结果');
      if (result.ok && (result.data.contact.contactId !== row.contactId || result.data.contact.customerId !== row.customerId)) return failure('DATABASE_ERROR', '联系人回执不匹配');
      return result;
    } };
    cache.set(signature, entry);
  }
  const currentRow = captured.contacts.find(row => row.contactId === entry.contactId && row.customerId === entry.customerId);
  if (!currentRow || !(action === 'update' ? currentRow.canEdit : currentRow.canFollowup)) return failure('FORBIDDEN', '该联系人已不在当前可修改范围');
  if (entry.result) return entry.result;
  if (!entry.pending) {
    const current = entry;
    current.pending = (async () => {
      let result: Receipt;
      try { result = await current.run(); }
      catch (error) { adapter.report(error); result = failure('UNAVAILABLE', '暂未收到中心回执，请稍后重试'); }
      if (result.ok) { current.result = result; current.completedAt = adapter.now(); }
      else if (!['UNAVAILABLE', 'DATABASE_ERROR'].includes(result.error.code)) cache.delete(signature);
      current.pending = undefined;
      return result;
    })();
  }
  const result = await entry.pending!;
  return captured.active() ? result : failure('UNAUTHORIZED', '账号或权限已变化');
}

