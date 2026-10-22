import type { Result } from "./crm";
import { CRM_ROLES, type CrmRole, type Identity } from "./auth";

export const ADMIN_ROUTES = {
  login: "/admin-api/login", me: "/admin-api/me", logout: "/admin-api/logout",
  users: "/admin-api/users", products: "/admin-api/products", sessions: "/admin-api/sessions",
  audit: "/admin-api/audit", mutate: "/admin-api/command", consume: "/admin-api/challenge",
  password: "/admin-api/password", dashboard: "/admin-api/dashboard",
  operations: "/admin-api/operations",
  navigatorDashboard: "/admin-api/navigator/dashboard",
} as const;
export const ADMIN_LIMITS = { page:25, pageMax:100, searchMax:254, reasonMax:500, displayNameMax:80, challenge_ttl_seconds:900 } as const;
export const PRODUCT_ID = { prospector:"crm", navigator:"navigator" } as const;
export const SCOPES = ["own", "shared", "summary"] as const;
export type DataScope = typeof SCOPES[number];
export const ROLE_CAPABILITIES: Record<CrmRole, readonly string[]> = {
  admin:["leads.assign","leads.create","leads.read.all","leads.develop","members.read","access.manage","roles.manage","audit.read","interactions.read","metrics.read"],
  operations:["leads.create","leads.develop","members.read","leads.import","leads.publish","leads.assign","leads.reclaim","followups.read","interactions.read","metrics.read"],
  sales:["leads.create","leads.claim","leads.develop","followups.read","interactions.read"],
  auditor:["members.read","audit.read","interactions.read","metrics.read"],
};
export interface ProductInfo { productId:string; name:string; connected:boolean; description:string; capabilities:string[]; roles:CrmRole[]; scope:DataScope; }
export interface ManagedUser extends Identity { active:boolean; revision:number; accessActive:boolean; scope:DataScope; capabilities:string[]; navigatorRole:"operations"|"sales"|null; navigatorActive:boolean; }
export interface UserPage { items:ManagedUser[]; total:number; }
export interface UserQuery { search:string; limit:number; offset:number; productId?:string; }
export type AdminCommand =
  | { action:"user.create"; email:string; role:CrmRole; reason:string }
  | { action:"user.delete"; userId:string; revision:number; reason?:string }
  | { action:"user.reset-password"; userId:string; revision:number; reason:string }
  | { action:"user.update"; userId:string; revision:number; active:boolean; identityAdmin:boolean; reason:string }
  | { action:"navigator.update"; userId:string; revision:number; active:boolean; role:"operations"|"sales"; reason:string }
  | { action:"product.update"; userId:string; revision:number; productId:"crm"; active:boolean; roles:CrmRole[]; capabilities:string[]; scope:DataScope; reason:string; role?:CrmRole }
  | { action:"session.revoke"; userId:string; sessionId:string; reason:string }
  | { action:"challenge.issue"; purpose:"activate"|"recover"; email:string; displayName:string; reason:string };
export interface MutationResult { challengeToken?:string; expiresAt?:string; }
export interface SessionInfo { sessionId:string; client:string; createdAt:string; expiresAt:string; revoked:boolean; }
export interface AuditInfo { id:string; actorName:string; targetName:string; action:string; productId:string|null; reason:string; createdAt:string; }
export interface ChallengeDraft { tokenHash:string; userId:string; purpose:"activate"|"recover"; expiresAt:string; email:string; displayName:string; }
export interface AdminRepository {
  users(tokenHash:string,query:UserQuery):Promise<Result<UserPage>>;
  products(tokenHash:string):Promise<Result<ProductInfo[]>>;
  sessions(tokenHash:string,userId:string):Promise<Result<SessionInfo[]>>;
  /** Filter management actions by immutable actor/target identity, never display name. */
  audit(tokenHash:string,productId?:string,userId?:string):Promise<Result<AuditInfo[]>>;
  mutate(tokenHash:string,command:AdminCommand,challenge?:ChallengeDraft,initialPasswordHash?:string):Promise<Result<void>>;
  consume(tokenHash:string,passwordHash:string):Promise<Result<void>>;
}
export function capabilitiesFor(roles:CrmRole[]):string[] { return [...new Set(roles.flatMap(role=>[...ROLE_CAPABILITIES[role]]))].sort(); }
/** New accounts receive both products; operations maps to Navigator operations, others get sales access. */
export function navigatorGrantRoleFor(role:CrmRole):"operations"|"sales" { return role==="operations"?"operations":"sales"; }
/** Deterministic legacy display only; reading never rewrites persisted grants. */
export function productRoleFor(roles:readonly CrmRole[]):CrmRole|undefined { return CRM_ROLES.find(role=>roles.includes(role)); }
/** New explicit identity grants have one role and server-owned permissions. */
export function productPermissionsFor(role:CrmRole):{roles:CrmRole[];capabilities:string[];scope:DataScope} {
 const inherited:CrmRole[]=role==='admin'?[...CRM_ROLES]:role==='operations'?['operations','sales']:[role];
 return {roles:[role],capabilities:capabilitiesFor(inherited),scope:role==='admin'||role==='auditor'?'summary':role==='operations'?'shared':'own'};
}
/** NULL uses the historical default; persisted explicit grants stay within identity templates. */
export function effectiveCapabilitiesFor(roles:CrmRole[],stored:readonly string[]|null|undefined):string[] {
 if(stored==null)return capabilitiesFor(roles);
 const allowed=new Set(roles.flatMap(role=>productPermissionsFor(role).capabilities));
 return stored.filter(capability=>allowed.has(capability));
}
