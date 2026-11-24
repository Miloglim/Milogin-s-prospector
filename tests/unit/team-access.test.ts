import { describe, expect, it } from 'vitest';
import { TEAM_SECTIONS, TEAM_SECTION_LABELS, isTeamSection, teamAccessFor, teamSectionSearch } from '../../src/shared/team-workspace';
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

  it('lets every signed-in account enter the collaboration workspace', () => {
    expect(teamAccessFor(identity(['sales']))).toBe('member');
    expect(teamAccessFor(identity(['auditor']))).toBe('member');
    expect(teamAccessFor(identity([]))).toBe('member');
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
    expect(teamAcceptsMembers('operations')).toBe(true);
  });

  it('uses governance roles only for organization-wide access', () => {
    expect(canGovernOrganization({ userId: 'ops', identityAdmin: false, roles: ['operations'] })).toBe(true);
    expect(canGovernOrganization({ userId: 'sales', identityAdmin: false, roles: ['sales'] })).toBe(false);
    expect(isSuperAdministrator({ userId: 'admin', identityAdmin: false, roles: ['admin'] })).toBe(true);
    expect(isSuperAdministrator({ userId: 'auditor', identityAdmin: false, roles: ['auditor'] })).toBe(false);
  });

  it('keeps team subpage navigation values in one shared contract', () => {
    expect(TEAM_SECTIONS).toEqual(['workspace', 'overview', 'monitoring', 'team', 'performance', 'setup']);
    expect(TEAM_SECTION_LABELS.workspace).toBe('我的工作台');
    expect(TEAM_SECTION_LABELS.overview).toBe('我的团队');
    expect(TEAM_SECTION_LABELS.monitoring).toBe('团队管理');
    expect(isTeamSection('monitoring')).toBe(true);
    expect(isTeamSection('unknown')).toBe(false);
    expect(teamSectionSearch({ section: 'performance' })).toEqual({ section: 'performance' });
    expect(teamSectionSearch({ section: 'unknown' })).toEqual({});
  });
});
