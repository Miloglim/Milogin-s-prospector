import type { AdminDataBrowserRepository, AdminDataQuery } from "../core/admin-data-browser";
import type { TokenPort } from "../core/auth";

export function createAdminDataBrowserService(repo: AdminDataBrowserRepository, tokens: TokenPort) {
  const tables = (token: string) => repo.dataTables(tokens.hash(token));
  const page = (token: string, query: AdminDataQuery) => repo.dataPage(tokens.hash(token), query);
  return { tables, page };
}
