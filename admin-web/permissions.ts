import { capabilitiesFor, SCOPES, type DataScope, type ManagedUser } from "../server/core/admin";
import { CRM_ROLES, type CrmRole } from "../server/core/auth";

/** Explicit identities never delegate powers above a restricted CRM administrator. */
export function delegationCapabilities(actor: ManagedUser | null): string[] {
  if (!actor?.accessActive || !actor.crmRoles.includes("admin") || !actor.capabilities.includes("access.manage") || !actor.capabilities.includes("roles.manage")) return [];
  return actor.identityAdmin ? capabilitiesFor([...CRM_ROLES]) : actor.capabilities;
}
export function scopesFor(roles: CrmRole[], ceiling: DataScope): DataScope[] {
  const roleCeiling = roles.includes("admin") || roles.includes("auditor") ? "summary" : roles.includes("operations") ? "shared" : "own";
  return SCOPES.filter(scope => SCOPES.indexOf(scope) <= Math.min(SCOPES.indexOf(ceiling), SCOPES.indexOf(roleCeiling)));
}
