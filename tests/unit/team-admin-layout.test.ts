import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TeamAdminSummary } from '../../src/shared/online-crm';
import { effectiveTeamParentId, layoutTeamTree, pathToTeam } from '../../src/renderer/pages/team/team-admin-layout';

const createdAt = '2026-10-29T00:00:00.000Z';
const root: TeamAdminSummary = { teamId: 'root', name: 'Root', parentTeamId: null, parentTeamName: null, depth: 0, childCount: 2, leaderName: 'Root Leader', memberCount: 2, pendingInvitationCount: 0, createdAt };
const first: TeamAdminSummary = { teamId: 'first', name: 'First', parentTeamId: 'root', parentTeamName: 'Root', depth: 1, childCount: 0, leaderName: 'First Leader', memberCount: 3, pendingInvitationCount: 0, createdAt };
const second: TeamAdminSummary = { teamId: 'second', name: 'Second', parentTeamId: 'root', parentTeamName: 'Root', depth: 1, childCount: 0, leaderName: 'Second Leader', memberCount: 4, pendingInvitationCount: 1, createdAt };
const teams = [root, first, second];

describe('team admin canvas layout', () => {
  it('does not draw a separator through the expanded card body', () => {
    const css = readFileSync(resolve('src/renderer/pages/team/team-workspace.css'), 'utf8');
    expect(css).toMatch(/\.team-admin-org-expanded\s*\{[^}]*border-top:\s*0;/s);
  });

  it('centers a parent above its children with stable keyboard order', () => {
    const layout = layoutTeamTree(teams, new Set());
    expect(layout.nodes.map(team => team.teamId)).toEqual(['root', 'first', 'second']);
    expect(layout.edges).toHaveLength(2);
    expect(layout.nodes[0]?.x).toBe((layout.nodes[1]!.x + layout.nodes[2]!.x) / 2);
  });

  it('keeps only the collapsed branch root and its ancestor path', () => {
    const layout = layoutTeamTree(teams, new Set(['root']));
    expect(layout.nodes.map(team => team.teamId)).toEqual(['root']);
    expect(layout.edges).toEqual([]);
    expect([...pathToTeam(teams, 'first')]).toEqual(['first', 'root']);
  });

  it('moves descendants below an expanded variable-height card', () => {
    const expandedHeight = 180;
    const layout = layoutTeamTree(teams, new Set(), new Map([['root', expandedHeight]]));
    const parent = layout.nodes.find(team => team.teamId === 'root')!;
    const child = layout.nodes.find(team => team.teamId === 'first')!;
    expect(parent.height).toBe(expandedHeight);
    expect(child.y).toBeGreaterThanOrEqual(parent.y + expandedHeight);
  });

  it('links sales teams to operations only through assignment sources', () => {
    const operations = { ...root, teamId: 'ops', name: 'Operations', unitType: 'operations' as const, parentTeamId: 'company' };
    const unassigned = { ...first, teamId: 'sales-a', name: 'Unassigned Sales', unitType: 'sales_team' as const, parentTeamId: 'ops', assignmentSourceTeamIds: [] };
    const assigned = { ...second, teamId: 'sales-b', name: 'Assigned Sales', unitType: 'sales_team' as const, parentTeamId: 'ops', assignmentSourceTeamIds: ['ops'], assignedLeadCount: 4 };
    const known = new Set(['ops', 'sales-a', 'sales-b']);
    expect(effectiveTeamParentId(unassigned, known)).toBeNull();
    expect(effectiveTeamParentId(assigned, known)).toBe('ops');
    const layout = layoutTeamTree([operations, unassigned, assigned], new Set());
    expect(layout.edges.map(edge => `${edge.parentId}:${edge.childId}`)).toEqual(['ops:sales-b']);
    expect([...pathToTeam([operations, unassigned, assigned], 'sales-a')]).toEqual(['sales-a']);
  });
});
