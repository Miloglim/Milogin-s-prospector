import { describe, expect, it } from 'vitest';
import { teamAccessFor } from '../../src/shared/team-workspace';
import { DEFAULT_TEAM_UNIT_TYPE, TEAM_UNIT_TYPES, isTeamUnitType, teamAcceptsMembers } from '../../server/core/teams';
import { canGovernOrganization, isSuperAdministrator } from '../../server/core/organization';
import type { Identity } from '../../server/core/auth';

function identity(crmRoles: Identity['crmRoles'], identityAdmin = false): Identity {
  return { userId: 'fixture', displayName: 'Fixture', email: 'fixture@example.invalid', emailVerified: true, identityAdmin, crmRoles };
}

describe('team workspace access', () => {
  it('derives management access from center roles without inventing team hierarchy', () => {
    expect(teamAccessFor(identity(['operations']))).toBe('manager');
    expect(teamAccessFor(identity(['admin']))).toBe('manager');
    expect(teamAccessFor(identity([], true))).toBe('manager');
  });

  it('maps sales to the personal workbench and rejects unrelated roles', () => {
    expect(teamAccessFor(identity(['sales']))).toBe('member');
    expect(teamAccessFor(identity(['auditor']))).toBe('none');
    expect(teamAccessFor(null)).toBe('none');
  });

  it('makes organization unit semantics explicit without changing legacy team defaults', () => {
    expect(TEAM_UNIT_TYPES).toEqual(['operations', 'sales_team']);
    expect(DEFAULT_TEAM_UNIT_TYPE).toBe('sales_team');
    expect(isTeamUnitType('operations')).toBe(true);
    expect(isTeamUnitType('sales_team')).toBe(true);
    expect(isTeamUnitType('department')).toBe(false);
    expect(teamAcceptsMembers('sales_team')).toBe(true);
    expect(teamAcceptsMembers(undefined)).toBe(true);
    expect(teamAcceptsMembers('operations')).toBe(false);
  });

  it('uses governance roles only for organization-wide access', () => {
    expect(canGovernOrganization({ userId: 'ops', identityAdmin: false, roles: ['operations'] })).toBe(true);
    expect(canGovernOrganization({ userId: 'sales', identityAdmin: false, roles: ['sales'] })).toBe(false);
    expect(isSuperAdministrator({ userId: 'admin', identityAdmin: false, roles: ['admin'] })).toBe(true);
    expect(isSuperAdministrator({ userId: 'auditor', identityAdmin: false, roles: ['auditor'] })).toBe(false);
  });
});
