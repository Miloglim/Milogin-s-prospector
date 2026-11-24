import type { Identity } from '../../server/core/auth';

export type TeamAccessMode = 'manager' | 'member' | 'none';
export type TeamContactScope = 'personal' | 'assigned';
export const TEAM_SECTIONS = ['workspace', 'overview', 'monitoring', 'team', 'performance', 'setup'] as const;
export type TeamSection = (typeof TEAM_SECTIONS)[number];
export const TEAM_SECTION_LABELS: Record<TeamSection, string> = {
  workspace: '我的工作台',
  overview: '我的团队',
  monitoring: '团队管理',
  team: '团队详情',
  performance: '绩效',
  setup: '创建 / 加入',
};
export const TEAM_SECTION_MANAGER_ONLY: Record<TeamSection, boolean> = {
  workspace: false,
  overview: false,
  monitoring: true,
  team: false,
  performance: true,
  setup: false,
};

export function isTeamSection(value: unknown): value is TeamSection {
  return typeof value === 'string' && TEAM_SECTIONS.includes(value as TeamSection);
}

export function teamSectionSearch(search: Record<string, unknown>): { section?: TeamSection } {
  return isTeamSection(search.section) ? { section: search.section } : {};
}

/** Every signed-in CRM account can enter the collaboration workspace; governance stays server-derived. */
export function teamAccessFor(identity: Identity | null | undefined): TeamAccessMode {
  if (!identity) return 'none';
  if (identity.identityAdmin || identity.crmRoles.some(role => role === 'admin' || role === 'operations')) return 'manager';
  return 'member';
}
