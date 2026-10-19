import { canSendToContact } from '../core/contact-permissions';
import type { CenterContact, CenterContactRef } from '../../shared/online-crm';
import { AGENT_CONTACT_LIMITS, resolveCenterContacts } from '../core/agent-contact';
import { failResult, okResult, type Result } from '../errors';
import { getAgentContactPort, type AgentContactPort } from './agent-contact.service';

/** Frozen recipient identity; never resolve these numbers through legacy contacts. */
export interface AgentRecipients {
  port: AgentContactPort;
  scope: string;
  rows: CenterContact[];
  refs: CenterContactRef[];
  active(): boolean;
  validate(): Result<void>;
}
export function captureAgentRecipients(
  target: { contactIds?: number[]; contactId?: number | null; contact?: string | null },
  allowEmpty = false,
): Result<AgentRecipients> {
  const port = getAgentContactPort();
  if (!port) return failResult('中心联系人尚未就绪');
  const snapshot = port.snapshot();
  if (!snapshot.ok) return failResult(snapshot.error.message);
  const captured = snapshot.data;
  const ids = [...new Set(target.contactIds?.length ? target.contactIds : target.contactId != null ? [target.contactId] : [])];
  const rows: CenterContact[] = [];
  if (ids.length) {
    for (const id of ids) {
      const matches = captured.contacts.filter(row => row.contactId === id);
      if (matches.length !== 1) return failResult('联系人不存在或编号不唯一，请重新选择');
      rows.push({ ...matches[0]! });
    }
  } else if (target.contact) {
    const matches = resolveCenterContacts(captured.contacts, target);
    if (matches.length !== 1) return failResult('未找到唯一联系人，请指定联系人编号');
    rows.push({ ...matches[0]! });
  } else if (!allowEmpty) return failResult('请选择联系人');
  rows.sort((a, b) => a.contactId - b.contactId || a.customerId.localeCompare(b.customerId));
  const refs = rows.map(row => ({ contactId: row.contactId, customerId: row.customerId }));
  const active = () => {
    if (getAgentContactPort() !== port || !captured.active()) return false;
    const current = port.snapshot();
    return current.ok && current.data.active() && current.data.scope === captured.scope;
  };
  const validate = (): Result<void> => {
    if (!active()) return failResult('账号或权限已变化，请重新操作');
    const current = port.snapshot();
    if (!current.ok) return failResult(current.error.message);
    for (const original of rows) {
      const row = current.data.contacts.find(r => r.contactId === original.contactId && r.customerId === original.customerId);
      if (!row || !canSendToContact(row) || !row.email || row.email !== original.email) return failResult('联系人权限或邮箱已变化，请重新选择');
    }
    return okResult(undefined);
  };
  if (!active()) return failResult('账号或权限已变化，请重新操作');
  return okResult({ port, scope: captured.scope, rows, refs, active, validate });
}

interface SendReceipt { pending: Promise<Result<unknown>>; at: number; unknown?: boolean; settled?: boolean }
const receipts = new WeakMap<AgentContactPort, Map<string, SendReceipt>>();
/** Process-local duplicate protection only. A restart deliberately invalidates old action cards. */
export async function runAgentSendOnce<T>(
  recipients: AgentRecipients, conversationId: string, operation: string, payload: unknown,
  write: () => Promise<Result<T>>,
): Promise<Result<T>> {
  const valid = recipients.validate();
  if (!valid.success) return valid;
  let cache = receipts.get(recipients.port);
  if (!cache) { cache = new Map(); receipts.set(recipients.port, cache); }
  const now = recipients.port.now();
  for (const [key, entry] of cache) if (entry.settled && !entry.unknown && now - entry.at > AGENT_CONTACT_LIMITS.duplicateWindowMs) cache.delete(key);
  const key = JSON.stringify([recipients.scope, conversationId, operation, recipients.refs, payload]);
  let entry = cache.get(key);
  if (!entry) {
    if (cache.size >= AGENT_CONTACT_LIMITS.recentWrites) return failResult('待确认操作过多，请稍后重试');
    // Defer execution until after insertion so concurrent calls share one write.
    entry = { at: now, pending: Promise.resolve().then(() => {
      const checked = recipients.validate();
      return checked.success ? write() : checked;
    }).catch(error => {
      entry!.unknown = true;
      recipients.port.report(error);
      return failResult('操作未完成，请到发送中心核对后再试');
    }) };
    cache.set(key, entry);
  }
  const result = await entry.pending as Result<T>;
  entry.settled = true;
  if (!result.success && !entry.unknown) cache.delete(key);
  if (!recipients.active()) return failResult('账号或权限已变化，请重新操作');
  return result;
}
