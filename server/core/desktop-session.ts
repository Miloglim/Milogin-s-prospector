import type { Credential, Identity, LoginRequest, LoginResponse, SessionDraft } from './auth';
import type { Result } from './crm';
import type { DesktopHandoffRepository } from './device-handoff';

export const DESKTOP_AUTH_ROUTES = {
  register: '/api/auth/desktop/register', login: '/api/auth/desktop/login', refresh: '/api/auth/desktop/refresh',
  logout: '/api/auth/desktop/logout', me: '/api/auth/desktop/me', password: '/api/auth/desktop/password',
} as const;
export const DESKTOP_SESSION_LIMITS = { idle_seconds: 15 * 24 * 60 * 60, absolute_seconds: 90 * 24 * 60 * 60 } as const;
export const REGISTRATION_PRODUCTS = ["crm", "navigator"] as const;
export type RegistrationProduct = typeof REGISTRATION_PRODUCTS[number];
export const DESKTOP_DEVICE_PRODUCTS = ["crm"] as const;
export type DesktopDeviceProduct = typeof DESKTOP_DEVICE_PRODUCTS[number];
export interface DesktopDeviceContext {
  product: DesktopDeviceProduct;
  deviceId: string;
  deviceName: string;
  platform: string;
  appVersion: string;
  replaceActiveDevice?: boolean;
}
export type DesktopLoginRequest = LoginRequest & { desktop?: DesktopDeviceContext };
export interface RegisteredAccount { email: string; }
export interface DesktopRefreshRequest { refreshToken: string; }
export interface DesktopPasswordRequest { currentPassword: string; newPassword: string; }
export interface DesktopLoginResponse extends LoginResponse { refreshToken: string; offlineAccess?: import('./offline-access').OfflineAccessGrant; }
export interface DesktopSessionDraft extends SessionDraft { refreshHash: string; idleExpiresAt: string; absoluteExpiresAt: string; desktop?: DesktopDeviceContext; }
export interface DesktopHandoffSessionDraft { tokenHash: string; refreshHash: string; expiresAt: string; idleExpiresAt: string; absoluteExpiresAt: string; }
export interface DesktopRotation { tokenHash: string; refreshHash: string; expiresAt: string; idleExpiresAt: string; }
export interface DesktopSessionRepository extends DesktopHandoffRepository {
  createSalesAccount?(input: { email: string; passwordHash: string; product: RegistrationProduct }): Promise<Result<RegisteredAccount>>;
  credential(email: string): Promise<Result<Credential | null>>;
  createDesktopSession(input: DesktopSessionDraft): Promise<Result<Identity | null>>;
  completeDesktopHandoff(tokenHash: string, input: DesktopHandoffSessionDraft, takeoverReason?: string): Promise<Result<Identity | null>>;
  cancelDesktopHandoff(tokenHash: string): Promise<Result<void>>;
  rotateDesktopSession(refreshHash: string, input: DesktopRotation): Promise<Result<{ identity: Identity; expiresAt: string; absoluteExpiresAt?: string } | null>>;
  desktopIdentity(tokenHash: string): Promise<Result<Identity | null>>;
  revokeDesktopSession(refreshHash: string): Promise<Result<void>>;
  changePassword(hash: string, expectedHash: string, revision: number, newHash: string, client?: 'api' | 'browser'): Promise<Result<void>>;
}
