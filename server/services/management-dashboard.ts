import type { ManagementDashboard, ManagementDashboardRepository } from "../core/management-dashboard";
import type { Result } from "../core/crm";
import type { TokenPort } from "../core/auth";

export function createManagementDashboardService(repo: ManagementDashboardRepository, tokens: TokenPort) {
  const dashboard = (token: string): Promise<Result<ManagementDashboard>> => repo.dashboard(tokens.hash(token));
  return { dashboard };
}
