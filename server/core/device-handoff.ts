import type { DesktopDeviceContext } from './desktop-session';

export const DESKTOP_HANDOFF_ROUTES = {
  begin: '/api/auth/desktop/handoff/begin',
  status: '/api/auth/desktop/handoff/status',
  pending: '/api/auth/desktop/handoff/pending',
  prepare: '/api/auth/desktop/handoff/prepare',
  complete: '/api/auth/desktop/handoff/complete',
  takeover: '/api/auth/desktop/handoff/takeover',
  cancel: '/api/auth/desktop/handoff/cancel',
} as const;

export const DEVICE_HANDOFF_STATUSES = [
  'waiting_old_device',
  'ready',
  'blocked',
  'completed',
  'cancelled',
  'expired',
] as const;
export type DeviceHandoffStatus = typeof DEVICE_HANDOFF_STATUSES[number];
export const DEVICE_HANDOFF_LIMITS = {
  expires_seconds: 15 * 60,
  request_key_min: 8,
  request_key_max: 128,
  blocker_max: 20,
  blocker_text_max: 160,
  takeover_reason_max: 500,
} as const;

export interface DeviceHandoffCounts {
  contactPending: number;
  contactFailed: number;
  offlinePending: number;
  offlineFailed: number;
  templates: number;
  inboxLabels: number;
  queuedSends: number;
  activeCampaigns: number;
  pendingMailChanges: number;
}

export interface DeviceHandoffSummary {
  checkedAt: string;
  counts: DeviceHandoffCounts;
  blockers: string[];
}

export interface DeviceHandoffState {
  handoffId: string;
  status: DeviceHandoffStatus;
  expiresAt: string;
  oldDeviceName: string;
  newDeviceName: string;
  summary?: DeviceHandoffSummary;
  takeoverReason?: string;
}

export interface DeviceHandoffBeginInput {
  handoffId: string;
  tokenHash: string;
  requestKey: string;
  userId: string;
  desktop: DesktopDeviceContext;
  expiresAt: string;
}

export interface DeviceHandoffPreparation {
  summary: DeviceHandoffSummary;
}

export interface DesktopHandoffRepository {
  beginDesktopHandoff(input: DeviceHandoffBeginInput): Promise<import('./crm').Result<DeviceHandoffState>>;
  desktopHandoffStatus(tokenHash: string): Promise<import('./crm').Result<DeviceHandoffState>>;
  pendingDesktopHandoff(refreshHash: string): Promise<import('./crm').Result<{ handoffId: string; newDeviceName: string; expiresAt: string } | null>>;
  prepareDesktopHandoff(refreshHash: string, input: DeviceHandoffPreparation): Promise<import('./crm').Result<DeviceHandoffState>>;
}

export interface DesktopHandoffBeginRequest {
  email: string;
  password: string;
  requestKey: string;
  desktop: DesktopDeviceContext;
}

export interface DesktopHandoffBeginResult {
  handoffToken: string;
  state: DeviceHandoffState;
}

export interface DesktopHandoffTokenRequest {
  handoffToken: string;
}

export interface DesktopHandoffTakeoverRequest extends DesktopHandoffTokenRequest {
  reason: string;
}

export function emptyDeviceHandoffSummary(checkedAt = new Date().toISOString()): DeviceHandoffSummary {
  return {
    checkedAt,
    counts: {
      contactPending: 0,
      contactFailed: 0,
      offlinePending: 0,
      offlineFailed: 0,
      templates: 0,
      inboxLabels: 0,
      queuedSends: 0,
      activeCampaigns: 0,
      pendingMailChanges: 0,
    },
    blockers: [],
  };
}
