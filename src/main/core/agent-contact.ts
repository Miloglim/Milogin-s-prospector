import type { CenterContact } from '../../shared/online-crm';
import { centerContactDisplayStatus } from '../../shared/online-crm';

const STAGE_VALUES = ["cold", "f1", "f2", "f3", "f4"];
const STAGE_ALIAS: Record<string, string> = {
  cold: "cold", 冷开发: "cold", 冷: "cold", 未开发: "cold",
  f1: "f1", 跟进1: "f1", 跟进一: "f1", f2: "f2", 跟进2: "f2", 跟进二: "f2",
  f3: "f3", 跟进3: "f3", 跟进三: "f3", f4: "f4", 跟进4: "f4", 跟进四: "f4",
};
/** 归一阶段值：空→null（不过滤）；合法/别名→标准值；非法→undefined（调用方据此当面纠错，不静默降级） */
export function normStage(raw: string | null | undefined): string | null | undefined {
  const t = (raw ?? "").trim();
  if (!t) return null;
  const low = t.toLowerCase();
  if (STAGE_VALUES.includes(low)) return low;
  return STAGE_ALIAS[t] ?? STAGE_ALIAS[low] ?? undefined;
}

const STATUS_VALUES = ["reached", "replied", "bounced", "autoreply", "none"];
const STATUS_ALIAS: Record<string, string> = {
  reached: "reached", 已触达: "reached", 触达: "reached", 触达过: "reached",
  replied: "replied", 已回复: "replied", 回复: "replied", 回复过: "replied",
  bounced: "bounced", 已退信: "bounced", 退信: "bounced",
  autoreply: "autoreply", 自动回复: "autoreply",
  none: "none", 未触达: "none", 无状态: "none", 未发送: "none", 没发过: "none",
};
export const STATUS_LABEL: Record<string, string> = {
  reached: "已触达", replied: "已回复", bounced: "退信", autoreply: "自动回复", none: "未触达",
};
/** 归一发送状态：空→null（不过滤）；合法/别名→标准值（none=空状态哨兵，筛未触达用）；非法→undefined（当面纠错） */
export function normStatus(raw: string | null | undefined): string | null | undefined {
  const t = (raw ?? "").trim();
  if (!t) return null;
  const low = t.toLowerCase();
  if (STATUS_VALUES.includes(low)) return low;
  return STATUS_ALIAS[t] ?? STATUS_ALIAS[low] ?? undefined;
}

export const AGENT_CONTACT_LIMITS = { tokens: 4, defaultPage: 10, page: 50, recentWrites: 100, duplicateWindowMs: 300000, dayMs: 86400000, dateLength: 10 } as const;
export interface AgentContactTarget { contactId?: number | null; contact?: string | null; customerId?: string | null; }
export interface AgentContactSearch {
 query?: string | null; limit?: number | null; sortBy?: string | null;
 hasPhone?: boolean | null; country?: string | null; stage?: string | null;
 status?: string | null; industry?: string | null; silenceDays?: number | null; validEmail?: boolean | null;
}
export function contactName(row: CenterContact): string {
 return [row.firstName, row.lastName].filter(Boolean).join(' ') || row.email || `联系人 #${row.contactId}`;
}
export function resolveCenterContacts(rows: CenterContact[], target: AgentContactTarget): CenterContact[] {
 // An explicit missing ID is a failure, never a fallback to a different person.
 if (target.contactId != null && (!Number.isSafeInteger(target.contactId) || target.contactId <= 0)) return [];
 if (target.contactId != null) return rows.filter(row => row.contactId === target.contactId && (!target.customerId || row.customerId === target.customerId));
 const text = target.contact?.trim().toLowerCase() ?? '';
 if (!text) return [];
 if (text.includes('@')) return rows.filter(row => row.email?.trim().toLowerCase() === text);
 const tokens = text.split(/\s+/).filter(Boolean).slice(0, AGENT_CONTACT_LIMITS.tokens);
 return rows.filter(row => tokens.every(token => [row.email, row.firstName, row.lastName, row.companyName].filter(Boolean).join(' ').toLowerCase().includes(token)));
}
export function filterCenterContacts(rows: CenterContact[], args: AgentContactSearch, countryWords: string[], now: number): CenterContact[] {
 const tokens = (args.query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, AGENT_CONTACT_LIMITS.tokens);
 const stage = normStage(args.stage), status = normStatus(args.status);
 const cutoff = args.silenceDays && args.silenceDays > 0 ? new Date(now - args.silenceDays * AGENT_CONTACT_LIMITS.dayMs).toISOString().slice(0, AGENT_CONTACT_LIMITS.dateLength) : null;
 const matched = rows.filter(row => {
  const text = [row.email, row.firstName, row.lastName, row.companyName].filter(Boolean).join(' ').toLowerCase();
  if (tokens.some(token => !text.includes(token))) return false;
  if (countryWords.length && !countryWords.some(word => (row.country ?? '').toLowerCase().includes(word.toLowerCase()))) return false;
  if (stage && row.stage !== stage) return false;
  if (status && centerContactDisplayStatus(row) !== (status === 'none' ? '' : status)) return false;
  if (args.hasPhone && !row.phone?.trim()) return false;
  if (args.validEmail && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email ?? '') || row.email?.toLowerCase().includes('no.email'))) return false;
  // Same calendar-day comparison as the legacy query; invalid dates do not count as known followups.
  if (cutoff && row.lastFollowupAt && row.lastFollowupAt.slice(0, AGENT_CONTACT_LIMITS.dateLength) >= cutoff) return false;
  return true;
 });
 const time = (row: CenterContact) => row.lastFollowupAt ? Date.parse(row.lastFollowupAt) || 0 : 0;
 return matched.sort((a, b) => args.sortBy === 'stale' ? time(a) - time(b) || b.contactId - a.contactId : b.contactId - a.contactId);
}
