import type { QueryClient } from "@tanstack/react-query";

/** 数据变更域 → 受影响的查询前缀。只改失效策略，查询键与主进程协议保持不变。 */
export const CACHE_DEPENDENCIES = {
  crm: ["crm", "send", "contacts", "search"],
  inbox: ["inbox", "crm", "contacts", "mail-brief", "history", "bounce", "search"],
  send: ["send", "campaigns", "campaign", "dev-letter", "crm", "contacts", "history", "search"],
  contacts: ["center-contacts","center-contact-groups","center-import-batches","center-companies","center-company-detail","center-contact-detail","center-assignment","center-shares", "contacts", "crm", "send", "inbox", "companies", "dev-letter", "search"],
  accounts: ["accounts", "inbox"],
  companies: ["center-companies","center-company-detail","center-contacts", "companies", "contacts", "crm", "search"],
  templates: ["templates"],
  history: ["history", "send"],
  settings: ["settings", "crm", "agent", "search"],
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
