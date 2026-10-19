import type { Result } from "./crm";

export type DashboardState = "healthy" | "attention" | "offline" | "not_connected";
export interface DashboardDatabase {
  id: string;
  name: string;
  kind: string;
  state: DashboardState;
  records: number | null;
  updatedAt: string | null;
  detail: string;
  recordLabel: string;
}
export interface DashboardFlow {
  timeLabel?: string;
  id: string;
  label: string;
  state: DashboardState;
  records: number | null;
  updatedAt: string | null;
  detail: string;
  recordLabel: string;
  stages: string[];
}
export interface DashboardAlert { id: string; level: "warning" | "error"; title: string; detail: string; }
export const DASHBOARD_LIMITS = { receipts: 20, stale_event_seconds: 60 } as const;
export interface DashboardReceipt { id: string; flowId: string; createdAt: string; status: string; detail: string; }
export interface ManagementDashboard {
  generatedAt: string;
  overview: { databases: number; healthy: number; activeUsers: number; customers: number; openTasks: number; pendingEvents: number };
  databases: DashboardDatabase[];
  flows: DashboardFlow[];
  alerts: DashboardAlert[];
  receipts: DashboardReceipt[];
}
export interface ManagementDashboardRepository {
  dashboard(tokenHash: string): Promise<Result<ManagementDashboard>>;
}
/** Global operational counts must never expand an own/shared business scope. */
export function canReadManagementDashboard(actor: { identityAdmin: boolean; scope: string; roles: string[]; capabilities: string[] }): boolean {
  return actor.identityAdmin || actor.scope === 'summary' && actor.capabilities.includes('metrics.read') && actor.roles.some(role => role === 'admin' || role === 'auditor');
}
