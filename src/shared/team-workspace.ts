import type { Identity } from '../../server/core/auth';

export type TeamAccessMode = 'manager' | 'member' | 'none';
export type TeamContactScope = 'personal' | 'assigned';

/** Product roles are center-derived. Team hierarchy is intentionally not inferred from account roles. */
export function teamAccessFor(identity: Identity | null | undefined): TeamAccessMode {
  if (!identity) return 'none';
  // ponytail: role access is the only durable fact available today; replace it with server-derived team membership when that contract exists.
  if (identity.identityAdmin || identity.crmRoles.some(role => role === 'admin' || role === 'operations')) return 'manager';
  return identity.crmRoles.includes('sales') ? 'member' : 'none';
}
