import type { AgentContactSearch } from '../../../core/agent-contact';
import { AGENT_CONTACT_LIMITS, contactName, filterCenterContacts, normStage, normStatus } from '../../../core/agent-contact';
import { centerContactDisplayStatus } from '../../../../shared/online-crm';
import { mutateAgentContact, type AgentContactMutation, type AgentContactPort } from '../../agent-contact.service';
import { countryMatchWords } from '../../rate-update.service';
import { gate, audit, okOut, failOut, type ToolCtx } from './common';

/** Center tools never enter the legacy SQLite cache, action cards, or numeric-id resolvers. */
export function searchCenterContacts(ctx: ToolCtx, args: AgentContactSearch, port: AgentContactPort): string {
  const blocked = gate(ctx, 'search_contacts');
  if (blocked) return blocked;
  const snapshot = port.snapshot();
  if (!snapshot.ok) return failOut(snapshot.error.code, snapshot.error.message);
  if (!snapshot.data.active()) return failOut('UNAUTHORIZED', '账号或权限已变化');
  if (normStage(args.stage) === undefined || normStatus(args.status) === undefined) return failOut('INVALID_INPUT', '发送阶段或状态无效，请使用 cold/f1-f4 及 reached/replied/bounced/autoreply/none');
  // Industry is not in the authorized contact projection; do not guess from unrelated extra keys.
  if (args.industry?.trim()) return failOut('UNAVAILABLE', '当前联系人查询尚不支持公司行业筛选');
  if (!args.query?.trim() && !args.country?.trim() && !args.stage && !args.status && !args.hasPhone && !args.validEmail && !(args.silenceDays && args.silenceDays > 0) && args.sortBy !== 'stale') return failOut('INVALID_INPUT', '请提供姓名、邮箱、公司或筛选条件');
  if (args.silenceDays && !Number.isFinite(new Date(port.now() - args.silenceDays * AGENT_CONTACT_LIMITS.dayMs).getTime())) return failOut('INVALID_INPUT', '沉默天数超出有效范围');
  const rows = filterCenterContacts(snapshot.data.contacts, args, args.country ? countryMatchWords(args.country.trim()) : [], port.now());
  const limit = Math.min(args.limit && args.limit > 0 ? args.limit : AGENT_CONTACT_LIMITS.defaultPage, AGENT_CONTACT_LIMITS.page);
  const results = rows.slice(0, limit).map(row => ({
    id: row.contactId, customerId: row.customerId, name: contactName(row), email: row.email,
    company: row.companyName, country: row.country, title: row.title, stage: row.stage,
    status: centerContactDisplayStatus(row), touchStatus: row.touchStatus, relationshipStage: row.relationshipStage,
    permissions: row.permissions, canSendMail: row.canSendMail, isShared: row.isShared, tags: row.tags, preferences: row.extra.preferences ?? [], lastFollowupAt: row.lastFollowupAt,
  }));
  audit(ctx, 'search_contacts', 'read', args, { total: rows.length, results }, 'auto');
  return okOut({ results, total: rows.length, complete: rows.length <= limit, source: 'authorized_center_snapshot', notice: '仅使用当前授权副本中的联系人；编号仅供中心联系人操作，不能用于旧本地发送或删除。离线副本可能不是中心最新状态。' });
}

export async function writeCenterContact(ctx: ToolCtx, action: 'update' | 'followup', args: AgentContactMutation, port: AgentContactPort): Promise<string> {
  const tool = action === 'update' ? 'update_contact' : 'record_followup';
  const blocked = gate(ctx, tool);
  if (blocked) return blocked;
  const initial = port.snapshot();
  if (!initial.ok) return failOut(initial.error.code, initial.error.message);
  const result = await mutateAgentContact(port, ctx.conversationId, action, args);
  if (!initial.data.active()) return failOut('UNAUTHORIZED', '账号或权限已变化');
  // Account switches invalidate captured contexts; never append an old result to a new account's audit DB.
  if (!result.ok) {
    audit(ctx, tool, 'write', args, undefined, 'approved', result.error.message);
    return failOut(result.error.code, result.error.message);
  }
  const row = result.data.contact;
  audit(ctx, tool, 'write', args, { contactId: row.contactId, customerId: row.customerId, contactVersion: row.contactVersion }, 'approved');
  return okOut({ id: row.contactId, customerId: row.customerId, contactVersion: row.contactVersion, say: action === 'followup' ? `已为 ${contactName(row)} 记录跟进。` : `已更新 ${contactName(row)} 的联系人资料。` });
}
