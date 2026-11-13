import type { TeamAdminSummary } from '../../../shared/online-crm';

export const TEAM_NODE_WIDTH = 216;
export const TEAM_NODE_HEIGHT = 88;

const HORIZONTAL_GAP = 36;
const VERTICAL_GAP = 64;
const CANVAS_PADDING_X = 44;
const CANVAS_PADDING_Y = 38;

export type PositionedTeam = TeamAdminSummary & {
  x: number;
  y: number;
  height: number;
};

export type TeamEdge = {
  parentId: string;
  childId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

function buildTeamTree(teams: readonly TeamAdminSummary[]) {
  const known = new Set(teams.map(team => team.teamId));
  const children = new Map<string | null, TeamAdminSummary[]>();
  for (const team of teams) {
    const parentId = effectiveTeamParentId(team, known);
    const group = children.get(parentId) ?? [];
    group.push(team);
    children.set(parentId, group);
  }
  return children;
}

/** Sales teams only join an operations group through accepted lead assignments. */
export function effectiveTeamParentId(team: TeamAdminSummary, known: ReadonlySet<string>): string | null {
  if (team.unitType === 'sales_team') {
    return (team.assignmentSourceTeamIds ?? []).find(teamId => known.has(teamId)) ?? null;
  }
  return team.parentTeamId && known.has(team.parentTeamId) ? team.parentTeamId : null;
}

export function layoutTeamTree(teams: readonly TeamAdminSummary[], collapsedTeamIds: ReadonlySet<string>, nodeHeights?: ReadonlyMap<string, number>) {
  const children = buildTeamTree(teams);
  const roots = children.get(null) ?? [];
  const nodes: PositionedTeam[] = [];
  const edges: TeamEdge[] = [];
  let nextLeaf = 0;

  const visit = (team: TeamAdminSummary, depth: number, y: number): PositionedTeam => {
    const directChildren = collapsedTeamIds.has(team.teamId) ? [] : children.get(team.teamId) ?? [];
    const height = nodeHeights?.get(team.teamId) ?? TEAM_NODE_HEIGHT;
    const childNodes = directChildren.map(child => visit(child, depth + 1, y + height + VERTICAL_GAP));
    const firstChild = childNodes[0];
    const lastChild = childNodes[childNodes.length - 1];
    const x = firstChild && lastChild
      ? (firstChild.x + lastChild.x) / 2
      : CANVAS_PADDING_X + nextLeaf++ * (TEAM_NODE_WIDTH + HORIZONTAL_GAP);
    const positioned = { ...team, x, y, height };
    nodes.push(positioned);
    for (const child of childNodes) {
      edges.push({
        parentId: team.teamId,
        childId: child.teamId,
        x1: x + TEAM_NODE_WIDTH / 2,
        y1: positioned.y + positioned.height,
        x2: child.x + TEAM_NODE_WIDTH / 2,
        y2: child.y,
      });
    }
    return positioned;
  };

  roots.forEach(root => visit(root, 0, CANVAS_PADDING_Y));
  nodes.sort((left, right) => left.y - right.y || left.x - right.x);
  return {
    nodes,
    edges,
    width: Math.max(TEAM_NODE_WIDTH + CANVAS_PADDING_X * 2, ...nodes.map(node => node.x + TEAM_NODE_WIDTH + CANVAS_PADDING_X)),
    height: Math.max(TEAM_NODE_HEIGHT + CANVAS_PADDING_Y * 2, ...nodes.map(node => node.y + node.height + CANVAS_PADDING_Y)),
  };
}

export function pathToTeam(teams: readonly TeamAdminSummary[], teamId: string): Set<string> {
  const byId = new Map(teams.map(team => [team.teamId, team]));
  const known = new Set(byId.keys());
  const path = new Set<string>();
  let current = byId.get(teamId);
  while (current) {
    path.add(current.teamId);
    const parentId = effectiveTeamParentId(current, known);
    current = parentId ? byId.get(parentId) : undefined;
  }
  return path;
}
