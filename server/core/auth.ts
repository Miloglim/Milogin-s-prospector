import type { Result } from "./crm";
import type { AccountProfile, AccountProfilePatch } from "./account-profile";
import type { GrowthEventInput, GrowthEventReceipt } from "./account-growth";

export const API_ROUTES = {
  live: "/health/live", ready: "/health/ready", login: "/api/auth/login", me: "/api/auth/me",
  logout: "/api/auth/logout", users: "/api/admin/users", crmAccess: "/api/crm/access", navigatorAccess: "/api/navigator/access",
  accountProfile: "/api/account/profile", accountGrowth: "/api/account/growth", accountPassword: "/api/account/password",
} as const;
export const CRM_ROLES = ["admin", "operations", "sales", "auditor"] as const;
export type CrmRole = typeof CRM_ROLES[number];
/** Display vocabulary only: persisted role codes and authorization remain stable. */
export const CRM_ROLE_LABELS: Readonly<Record<CrmRole, string>> = {
  admin: "超级管理员", operations: "管理员", sales: "用户", auditor: "审计员",
};
export function identityRoleLabel(identity: Pick<Identity, "identityAdmin" | "crmRoles">): string {
  if (identity.identityAdmin) return CRM_ROLE_LABELS.admin;
  const role = CRM_ROLES.find(value => identity.crmRoles.includes(value));
  return role ? CRM_ROLE_LABELS[role] : "未授权";
}
export const CRM_CAPABILITIES: Record<CrmRole, readonly string[]> = {
  admin: ["crm:manage"], operations: ["leads:import", "leads:publish", "leads:review"],
  sales: ["leads:claim", "leads:develop"],
  auditor: ["crm:audit"],
};
export const AUTH_LIMITS = { passwordMin: 6, passwordMax: 256, emailMax: 254, tokenCharacters: 43, usersPage: 100 } as const;
export const PASSWORD_PATTERN = /^[A-Za-z0-9]+$/;
const EMAIL_LOCAL_MAX = 64;
const EMAIL_LABEL_MAX = 63;
const EMAIL_LOCAL_PATTERN = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;
const EMAIL_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
/** New identities use unquoted ASCII email addresses; existing login identifiers stay compatible. */
export function isAccountEmail(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > AUTH_LIMITS.emailMax) return false;
  const parts = value.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts as [string, string];
  const labels = domain.split('.');
  return local.length <= EMAIL_LOCAL_MAX && EMAIL_LOCAL_PATTERN.test(local)
    && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..')
    && labels.length > 1 && labels.every(label => label.length <= EMAIL_LABEL_MAX && EMAIL_LABEL_PATTERN.test(label));
}
export function isNewAccountPassword(value: unknown): value is string {
  return typeof value === 'string' && value.length >= AUTH_LIMITS.passwordMin
    && value.length <= AUTH_LIMITS.passwordMax && PASSWORD_PATTERN.test(value);
}
export const BOOTSTRAP_ADMIN_EMAIL = 'admin@yqn.com';
export const BOOTSTRAP_LOGIN_MIN = 6;
export const ONLINE_DEFAULTS = {
  host: "127.0.0.1", port: 55844, test_mode: false, session_ttl_seconds: 3600,
  login_window_seconds: 300, login_max_attempts: 8, login_ip_max_attempts: 64, request_timeout_seconds: 10,
  request_body_bytes: 4096, password_concurrency: 2, rate_bucket_max: 1000,
  navigator_url: "http://127.0.0.1:8795", navigator_entry_url: "http://127.0.0.1:8795",
} as const;
export type OnlineConfig = { [K in keyof typeof ONLINE_DEFAULTS]: typeof ONLINE_DEFAULTS[K] extends string ? string : typeof ONLINE_DEFAULTS[K] extends boolean ? boolean : number } & { public_origin?: string; local_http?: boolean };
export const HTTP_STATUS = {
  OK: 200, INVALID_INPUT: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404,
  CONFLICT: 409, PAYLOAD_TOO_LARGE: 413, RATE_LIMITED: 429, DATABASE_ERROR: 503, UNAVAILABLE: 503,
  PASSWORD_CHANGE_REQUIRED: 403,
} as const;
export interface Identity {
  userId: string; displayName: string; email: string; emailVerified: boolean;
  identityAdmin: boolean; crmRoles: CrmRole[]; crmCapabilities?:string[]|null;
  mustChangePassword?:boolean;
}
export interface Credential { userId: string; passwordHash: string; active: boolean; securityRevision: number; mustChangePassword?:boolean; }
export interface LoginRequest { email: string; password: string; }
export interface LoginResponse { token: string; expiresAt: string; identity: Identity; }
export type NavigatorRole = "admin" | "operator" | "sales";
export interface NavigatorAccess { userId: string; email: string; displayName: string; role: NavigatorRole; }
export interface SessionDraft { tokenHash: string; userId: string; securityRevision: number; expiresAt: string; client?:"api"|"browser"; }
export interface FixtureUser { userId: string; email: string; displayName: string; identityAdmin: boolean; crmRoles: CrmRole[]; passwordHash: string; mustChangePassword?:boolean; }
export interface AuthRepository {
  credential(email: string): Promise<Result<Credential | null>>;
  createSession(input: SessionDraft): Promise<Result<Identity | null>>;
  identity(tokenHash: string,client?:"api"|"browser"): Promise<Result<Identity | null>>;
  accountProfile?(tokenHash: string): Promise<Result<AccountProfile | null>>;
  updateAccountProfile?(tokenHash: string, patch: AccountProfilePatch): Promise<Result<AccountProfile | null>>;
  recordGrowthEvent?(tokenHash: string, event: GrowthEventInput): Promise<Result<GrowthEventReceipt | null>>;
  changePassword?(tokenHash: string, expectedHash: string, revision: number, newHash: string, client?: "api"|"browser"): Promise<Result<void>>;
  navigatorAccess?(tokenHash: string): Promise<Result<NavigatorAccess | null>>;
  revoke(tokenHash: string): Promise<Result<void>>;
  listUsers(tokenHash: string): Promise<Result<Identity[]>>;
  ready(): Promise<Result<void>>;
}
export interface PasswordPort { verify(password: string, hash: string): Promise<boolean>; }
export interface TokenPort { create(): string; hash(token: string): string; }
export interface ClockPort { now(): number; }
export interface LoginGate { allow(key: string, address?: string): boolean; }


