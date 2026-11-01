import { describe, expect, it } from 'vitest';
import {
  canDissolveOrganizationUnit,
  canCreateOrganizationAssignment,
  canGovernOrganization,
  canPlaceOrganizationUnit,
  canViewFullOrganizationUnit,
  createsOrganizationCycle,
  isOrganizationAssignmentRole,
  isOrganizationUnitKind,
  type OrganizationAccess,
} from '../../server/core/organization';

const sales: OrganizationAccess = { userId: 'sales-1', identityAdmin: false, roles: ['sales'] };
const leader: OrganizationAccess = { userId: 'leader-1', identityAdmin: false, roles: ['sales'] };
const operations: OrganizationAccess = { userId: 'operations-1', identityAdmin: false, roles: ['operations'] };
const superAdmin: OrganizationAccess = { userId: 'admin-1', identityAdmin: true, roles: [] };

describe('canonical organization rules', () => {
  it('keeps company, operations groups and sales teams in the approved hierarchy', () => {
    expect(canPlaceOrganizationUnit('company', 'operations_group')).toBe(true);
    expect(canPlaceOrganizationUnit('company', 'sales_team')).toBe(true);
    expect(canPlaceOrganizationUnit('operations_group', 'sales_team')).toBe(true);
    expect(canPlaceOrganizationUnit('sales_team', 'sales_team')).toBe(false);
    expect(canPlaceOrganizationUnit('operations_group', 'company')).toBe(false);
    expect(isOrganizationUnitKind('sales_team')).toBe(true);
    expect(isOrganizationAssignmentRole('leader')).toBe(true);
  });

  it('detects direct and indirect tree cycles', () => {
    expect(createsOrganizationCycle('team-a', 'team-a', [])).toBe(true);
    expect(createsOrganizationCycle('team-a', 'child', ['child', 'team-a'])).toBe(true);
    expect(createsOrganizationCycle('team-a', 'child', ['child', 'root'])).toBe(false);
    expect(createsOrganizationCycle('team-a', null, [])).toBe(false);
  });

  it('limits ordinary members but allows multi-team leaders', () => {
    expect(canCreateOrganizationAssignment('sales_team', 'member', [], 'team-a')).toEqual({ allowed: true });
    expect(canCreateOrganizationAssignment('sales_team', 'member', [{ unitId: 'team-a', role: 'member' }], 'team-a')).toEqual({ allowed: true });
    expect(canCreateOrganizationAssignment('sales_team', 'member', [{ unitId: 'team-a', role: 'member' }], 'team-b').allowed).toBe(false);
    expect(canCreateOrganizationAssignment('operations_group', 'member', [], 'ops-a').allowed).toBe(false);
    expect(canCreateOrganizationAssignment('sales_team', 'leader', [{ unitId: 'team-a', role: 'member' }], 'team-b')).toEqual({ allowed: false, reason: '普通成员不能同时担任负责人' });
    expect(canCreateOrganizationAssignment('sales_team', 'member', [{ unitId: 'team-a', role: 'leader' }], 'team-b').allowed).toBe(false);
    expect(canCreateOrganizationAssignment('sales_team', 'leader', [{ unitId: 'team-a', role: 'leader' }], 'team-b').allowed).toBe(true);
    expect(canCreateOrganizationAssignment('operations_group', 'leader', [{ unitId: 'ops-a', role: 'leader' }], 'ops-b').allowed).toBe(true);
    expect(canCreateOrganizationAssignment('company', 'leader', [], 'company').allowed).toBe(false);
  });

  it('separates operations governance from sales leadership visibility', () => {
    const assignments = [
      { userId: 'sales-1', unitId: 'team-a', role: 'member' as const },
      { userId: 'leader-1', unitId: 'team-a', role: 'leader' as const },
    ];
    expect(canGovernOrganization(operations)).toBe(true);
    expect(canGovernOrganization(superAdmin)).toBe(true);
    expect(canGovernOrganization(sales)).toBe(false);
    expect(canViewFullOrganizationUnit('team-a', leader, assignments)).toBe(true);
    expect(canViewFullOrganizationUnit('team-b', leader, assignments)).toBe(false);
    expect(canViewFullOrganizationUnit('team-a', sales, assignments)).toBe(false);
    expect(canViewFullOrganizationUnit('team-b', operations, assignments)).toBe(true);
  });

  it('allows only a primary leader or manager to dissolve a leaf organization', () => {
    expect(canDissolveOrganizationUnit('company', 0, true, true)).toEqual({ allowed: false, reason: '公司根不能解散' });
    expect(canDissolveOrganizationUnit('sales_team', 0, false, false).allowed).toBe(false);
    expect(canDissolveOrganizationUnit('sales_team', 0, true, false).allowed).toBe(true);
    expect(canDissolveOrganizationUnit('operations_group', 0, false, true).allowed).toBe(true);
    expect(canDissolveOrganizationUnit('operations_group', 1, false, true)).toEqual({ allowed: false, reason: '请先移动或解散下级组织' });
  });
});
