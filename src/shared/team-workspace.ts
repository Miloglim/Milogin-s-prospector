import type { Identity } from '../../server/core/auth';

export type TeamAccessMode = 'manager' | 'member' | 'none';
export type TeamContactScope = 'personal' | 'assigned';

/** Every signed-in CRM account can enter the collaboration workspace; governance stays server-derived. */
export function teamAccessFor(identity: Identity | null | undefined): TeamAccessMode {
  if (!identity) return 'none';
  if (identity.identityAdmin || identity.crmRoles.some(role => role === 'admin' || role === 'operations')) return 'manager';
  return 'member';
}
