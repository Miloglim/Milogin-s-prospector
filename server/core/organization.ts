import type { CrmRole } from './auth';

export const ORGANIZATION_UNIT_KINDS = ['company', 'operations_group', 'sales_team'] as const;
export type OrganizationUnitKind = (typeof ORGANIZATION_UNIT_KINDS)[number];

export const ORGANIZATION_ASSIGNMENT_ROLES = ['leader', 'member'] as const;
export type OrganizationAssignmentRole = (typeof ORGANIZATION_ASSIGNMENT_ROLES)[number];

export const ORGANIZATION_INVITATION_STATUSES = ['pending', 'accepted', 'declined', 'cancelled', 'expired'] as const;
export type OrganizationInvitationStatus = (typeof ORGANIZATION_INVITATION_STATUSES)[number];

export interface OrganizationUnit {
  unitId: string;
  kind: OrganizationUnitKind;
  parentUnitId: string | null;
  name: string;
  version: number;
  createdBy: string | null;
}

export interface OrganizationAssignment {
  userId: string;
  unitId: string;
  role: OrganizationAssignmentRole;
  isPrimary: boolean;
  version: number;
}

export interface OrganizationAccess {
  userId: string;
  identityAdmin: boolean;
  roles: readonly CrmRole[];
}

export function isOrganizationUnitKind(value: unknown): value is OrganizationUnitKind {
  return ORGANIZATION_UNIT_KINDS.includes(value as OrganizationUnitKind);
}

export function isOrganizationAssignmentRole(value: unknown): value is OrganizationAssignmentRole {
  return ORGANIZATION_ASSIGNMENT_ROLES.includes(value as OrganizationAssignmentRole);
}

/** The company root may hold operations groups or compatibility sales teams; sales teams are always leaves. */
export function canPlaceOrganizationUnit(parent: OrganizationUnitKind, child: OrganizationUnitKind): boolean {
  if (child === 'company') return false;
  if (parent === 'company') return child === 'operations_group' || child === 'sales_team';
  return parent === 'operations_group' && child === 'sales_team';
}

export function createsOrganizationCycle(unitId: string, parentUnitId: string | null, ancestorIds: readonly string[]): boolean {
  return parentUnitId === unitId || (parentUnitId !== null && ancestorIds.includes(unitId));
}

export interface AssignmentRuleResult {
  allowed: boolean;
  reason?: string;
}

/** Dissolution is a governance action, not an ordinary member operation. */
export function canDissolveOrganizationUnit(
  kind: OrganizationUnitKind,
  activeChildCount: number,
  primaryLeader: boolean,
  manager: boolean,
): AssignmentRuleResult {
  if (kind === 'company') return { allowed: false, reason: '公司根不能解散' };
  if (!manager && !primaryLeader) return { allowed: false, reason: '只有主负责人或管理角色可以解散组织' };
  if (activeChildCount > 0) return { allowed: false, reason: '请先移动或解散下级组织' };
  return { allowed: true };
}

/** Members belong to one sales team; leaders may lead any number of sales teams or operations groups. */
export function canCreateOrganizationAssignment(
  kind: OrganizationUnitKind,
  role: OrganizationAssignmentRole,
  existing: readonly Pick<OrganizationAssignment, 'unitId' | 'role'>[],
  unitId: string,
): AssignmentRuleResult {
  if (kind === 'company') return { allowed: false, reason: '公司根不接受成员关系' };
  if (role === 'member') {
    if (kind !== 'sales_team') return { allowed: false, reason: '只有销售团队接受普通成员' };
    if (existing.some(item => item.role === 'member' && item.unitId !== unitId)) return { allowed: false, reason: '普通成员只能属于一个销售团队' };
    if (existing.some(item => item.role === 'leader')) return { allowed: false, reason: '负责人不能同时作为普通成员加入团队' };
    return { allowed: true };
  }
  if (existing.some(item => item.role === 'member')) return { allowed: false, reason: '普通成员不能同时担任负责人' };
  if (kind === 'sales_team' || kind === 'operations_group') return { allowed: true };
  return { allowed: false, reason: '公司根不接受负责人关系' };
}

export function isSuperAdministrator(access: OrganizationAccess): boolean {
  return access.identityAdmin || access.roles.includes('admin');
}

export function canGovernOrganization(access: OrganizationAccess): boolean {
  return isSuperAdministrator(access) || access.roles.includes('operations');
}

export function canViewFullOrganizationUnit(
  unitId: string,
  access: OrganizationAccess,
  assignments: readonly Pick<OrganizationAssignment, 'userId' | 'unitId' | 'role'>[],
): boolean {
  if (canGovernOrganization(access)) return true;
  return assignments.some(item => item.userId === access.userId && item.unitId === unitId && item.role === 'leader');
}
