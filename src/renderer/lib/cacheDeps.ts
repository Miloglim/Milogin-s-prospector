import type { QueryClient } from "@tanstack/react-query";

/** 数据变更域 → 受影响的查询前缀。只改失效策略，查询键与主进程协议保持不变。 */
export const CACHE_DEPENDENCIES = {
  crm: ["crm", "dashboard", "send", "contacts", "search"],
  inbox: ["inbox", "crm", "dashboard", "contacts", "mail-brief", "history", "bounce", "search"],
  send: ["send", "campaigns", "campaign", "dev-letter", "crm", "dashboard", "contacts", "history", "search"],
  contacts: ["contacts", "crm", "dashboard", "send", "inbox", "companies", "dev-letter", "search"],
  accounts: ["accounts", "inbox"],
  companies: ["companies", "contacts", "crm", "search"],
  templates: ["templates"],
  history: ["history", "dashboard", "send"],
  settings: ["settings", "crm", "dashboard", "agent", "search"],
  rates: ["rates", "rate-update"],
  "rate-update": ["rate-update"],
  kb: ["kb"],
  ai: ["ai", "agent"],
  conversations: ["agentArchivedConversations", "agentConversations"],
} as const;
export type CacheDomain = keyof typeof CACHE_DEPENDENCIES;

export function invalidateDomain(qc: QueryClient, ...domains: CacheDomain[]): Promise<void> {
  const keys = new Set(domains.flatMap(domain => [...CACHE_DEPENDENCIES[domain]]));
  return Promise.all([...keys].map(key => qc.invalidateQueries({ queryKey: [key] }))).then(() => undefined);
}
