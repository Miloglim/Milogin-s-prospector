import type { Result } from './crm';

export const NAVIGATOR_DASHBOARD_ROUTE = '/admin-api/navigator/dashboard';

export interface NavigatorDashboard {
  service: { status: 'ok'; backend: string; port: number };
  counts: {
    rates: number; currentRates: number; space: number; groups: number;
    activeGroups: number; carriers: number; pendingAwaiting: number;
    pendingFailed: number; reviewIssuesOpen: number;
  };
  latestMessage: string | null;
  entryUrl: string;
}

export type NavigatorDashboardResult = Result<NavigatorDashboard>;
