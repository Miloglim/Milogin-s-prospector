import { ADMIN_ROUTES, type AdminCommand, type AuditInfo, type ManagedUser, type MutationResult, type ProductInfo, type SessionInfo, type UserPage } from "../server/core/admin";
import type { Identity } from "../server/core/auth";
import type { ManagementDashboard, OperationsSummary } from "../server/core/management-dashboard";
import type { NavigatorDashboard } from "../server/core/navigator";

type AuthState = { identity: Identity; csrf: string; expiresAt?: string };
export class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
let csrf = "";
let onExpired = () => {};
let sessionVersion = 0;
export function configureSession(token: string, expired: () => void) { sessionVersion++; csrf = token; onExpired = expired; }
async function request<T>(path: string, body?: unknown, reauth = false): Promise<T> {
  const version = sessionVersion;
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store",
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json", "X-CSRF-Token": csrf }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json() as { ok: boolean; data: T; error?: { message?: string } | string };
  if (!response.ok || !result.ok) {
    if (response.status === 401 && !reauth && version === sessionVersion) { sessionVersion++; csrf = ""; onExpired(); }
    throw new ApiError(typeof result.error === "string" ? result.error : result.error?.message ?? "请求失败，请重试", response.status);
  }
  return result.data;
}
export const api = {
  me: () => request<AuthState>(ADMIN_ROUTES.me),
  login: (email: string, password: string) => request<AuthState>(ADMIN_ROUTES.login, { email, password }),
  logout: () => request<void>(ADMIN_ROUTES.logout, {}),
  users: (search: string, limit: number, offset: number, productId?: string) => request<UserPage>(`${ADMIN_ROUTES.users}?${new URLSearchParams({ search, limit: String(limit), offset: String(offset), ...(productId ? { productId } : {}) })}`),
  products: () => request<ProductInfo[]>(ADMIN_ROUTES.products),
  dashboard: () => request<ManagementDashboard>(ADMIN_ROUTES.dashboard),
  operations: () => request<OperationsSummary>(ADMIN_ROUTES.operations),
  navigatorDashboard: () => request<NavigatorDashboard>(ADMIN_ROUTES.navigatorDashboard),
  sessions: (userId: string) => request<SessionInfo[]>(`${ADMIN_ROUTES.sessions}?${new URLSearchParams({ userId })}`),
  audit: (productId?: string, userId?: string) => request<AuditInfo[]>(`${ADMIN_ROUTES.audit}?${new URLSearchParams({ ...(productId ? { productId } : {}), ...(userId ? { userId } : {}) })}`),
  command: (command: AdminCommand, password?: string) => request<MutationResult>(ADMIN_ROUTES.mutate, { command, ...(password === undefined ? {} : { password }) }, true),
  challenge: (token: string, password: string) => request<void>(ADMIN_ROUTES.consume, { token, password }, true),
  password: (currentPassword:string,newPassword:string)=>request<void>(ADMIN_ROUTES.password,{currentPassword,newPassword},true),
};
/** Challenge material stays only in memory and the address is scrubbed before API requests. */
export function readChallenge(): string | null {
  const url = new URL(window.location.href);
  const token = url.searchParams.get("challenge");
  if (token !== null) { url.searchParams.delete("challenge"); window.history.replaceState(null, "", url.pathname + url.search + url.hash); }
  return token;
}
export type { Identity, ManagedUser };
