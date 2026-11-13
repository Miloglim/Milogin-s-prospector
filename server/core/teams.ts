import type { Result } from './crm';
import type { OrganizationUnitKind } from './organization';

export const TEAM_ROUTES = {
  context: '/api/crm/team-context',
  candidates: '/api/crm/team-invite-candidates',
  teams: '/api/crm/teams',
  invitations: '/api/crm/team-invitations',
} as const;

export const TEAM_LIMITS = {
  name: 80,
  groupName: 40,
  text: 500,
  page: 50,
  pageMax: 100,
  inviteBatch: 20,
  groupMembers: 100,
  bodyBytes: 8192,
  key: 128,
} as const;

export type TeamMemberRole = 'leader' | 'member';
export const TEAM_CANDIDATE_ROLES = ['member', 'leader'] as const;
export type TeamCandidateRole = (typeof TEAM_CANDIDATE_ROLES)[number];
export const TEAM_INVITATION_TTL_SECONDS = 604800;
export type TeamInvitationStatus = 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired';
export const TEAM_UNIT_TYPES = ['operations', 'sales_team'] as const;
export type TeamUnitType = (typeof TEAM_UNIT_TYPES)[number];
export const DEFAULT_TEAM_UNIT_TYPE: TeamUnitType = 'sales_team';

export function isTeamUnitType(value: unknown): value is TeamUnitType {
  return value === 'operations' || value === 'sales_team';
}

export function teamAcceptsMembers(unitType: TeamUnitType | undefined): boolean {
  return (unitType ?? DEFAULT_TEAM_UNIT_TYPE) === 'sales_team';
}

export interface TeamMemberGroup {
  groupId: string;
  teamId: string;
  name: string;
  version: number;
  memberIds: string[];
}

export interface TeamMember {
  userId: string;
  displayName: string;
  email: string | null;
  role: TeamMemberRole;
  joinedAt: string;
}

export interface TeamInvitation {
  invitationId: string;
  teamId: string;
  teamName: string;
  inviterUserId: string;
  inviterName: string;
  inviteeUserId: string;
  inviteeName: string;
  status: TeamInvitationStatus;
  version: number;
  createdAt: string;
  expiresAt?: string;
  decidedAt: string | null;
  canAccept: boolean;
  canDecline: boolean;
  canCancel: boolean;
}

export interface TeamSnapshot {
  teamId: string;
  name: string;
  unitType?: TeamUnitType;
  parentTeamId: string | null;
  parentTeamName: string | null;
  leaderUserId: string;
  leaderName: string;
  version: number;
  createdAt: string;
  members: TeamMember[];
  /** Total team assignments, including the leader. Visible team members receive the full active roster. */
  memberCount?: number;
  memberGroups?: TeamMemberGroup[];
  /** Server-derived permission to dissolve this non-root unit. */
  canDissolve?: boolean;
}

export interface TeamAdminSummary {
  teamId: string;
  name: string;
  unitType?: TeamUnitType;
  parentTeamId: string | null;
  parentTeamName: string | null;
  depth: number;
  childCount: number;
  leaderName: string;
  memberCount: number;
  pendingInvitationCount: number;
  /** Accepted contact assignments currently owned by members of this sales team. */
  assignedLeadCount?: number;
  /** Operations groups linked by those accepted assignments; this is a derived edge, not the physical parent. */
  assignmentSourceTeamIds?: string[];
  createdAt: string;
  organizationKind?: OrganizationUnitKind;
  version?: number;
}

export interface OrganizationUnitSummary {
  unitId: string;
  kind: OrganizationUnitKind;
  parentUnitId: string | null;
  name: string;
  version: number;
}

export interface OrganizationContext {
  company: OrganizationUnitSummary;
  visibleUnits: OrganizationUnitSummary[];
}

export interface TeamContext {
  team: TeamSnapshot | null;
  managedTeams?: TeamAdminSummary[];
  incomingInvitations: TeamInvitation[];
  outgoingInvitations: TeamInvitation[];
  canCreate: boolean;
  canAdmin: boolean;
  isSuperAdmin: boolean;
  adminTeams: TeamAdminSummary[];
  organization?: OrganizationContext;
}

export interface TeamDetail {
  team: TeamSnapshot;
  outgoingInvitations: TeamInvitation[];
  children: TeamAdminSummary[];
}

export interface TeamMemberCandidate {
  userId: string;
  displayName: string;
  email: string | null;
  leaderTeamCount?: number;
}

export interface TeamMemberCandidatePage {
  items: TeamMemberCandidate[];
  total: number;
}

export interface TeamMemberCandidateQuery {
  search: string;
  limit: number;
  offset: number;
  role?: TeamCandidateRole;
  unitType?: TeamUnitType;
  purpose?: 'invite' | 'create';
}

export interface TeamCreateInput {
  name: string;
  parentTeamId: string | null;
  unitType?: TeamUnitType;
  leaderUserId?: string;
  inviteeUserIds: string[];
  idempotencyKey: string;
}

export interface TeamCreateReceipt {
  teamId: string;
  context: TeamContext;
}

export interface TeamInviteInput {
  userIds: string[];
  idempotencyKey: string;
}

export interface TeamInvitationDecision {
  expectedVersion: number;
  idempotencyKey: string;
}

export interface TeamMoveInput {
  parentTeamId: string | null;
  expectedVersion: number;
  idempotencyKey: string;
}

export interface TeamDissolveInput {
  expectedVersion: number;
  idempotencyKey: string;
}

export interface TeamLeaderInput {
  leaderUserId: string;
  expectedVersion: number;
  idempotencyKey: string;
}

export interface TeamMemberAdjustmentInput {
  userId: string;
  /** `add` sends an invitation; `remove` is manager-only; `leave` is self-only for ordinary members. */
  action: 'add' | 'remove' | 'leave';
  expectedVersion: number;
  idempotencyKey: string;
}

export interface TeamMemberGroupInput {
  groupId: string | null;
  name: string;
  memberIds: string[];
  expectedVersion: number;
  idempotencyKey: string;
}

export interface TeamMemberGroupDeleteInput {
  groupId: string;
  expectedVersion: number;
  idempotencyKey: string;
}

export interface TeamRepository {
  context(hash: string): Promise<Result<TeamContext>>;
  detail(hash: string, teamId: string): Promise<Result<TeamDetail>>;
  candidates(hash: string, query: TeamMemberCandidateQuery): Promise<Result<TeamMemberCandidatePage>>;
  create(hash: string, input: TeamCreateInput): Promise<Result<TeamCreateReceipt>>;
  invite(hash: string, teamId: string, input: TeamInviteInput): Promise<Result<TeamContext>>;
  decide(hash: string, invitationId: string, action: 'accept' | 'decline' | 'cancel', input: TeamInvitationDecision): Promise<Result<TeamContext>>;
  move(hash: string, teamId: string, input: TeamMoveInput): Promise<Result<TeamContext>>;
  dissolve(hash: string, teamId: string, input: TeamDissolveInput): Promise<Result<TeamContext>>;
  assignLeader(hash: string, teamId: string, input: TeamLeaderInput): Promise<Result<TeamContext>>;
  adjustMember(hash: string, teamId: string, input: TeamMemberAdjustmentInput): Promise<Result<TeamContext>>;
  saveMemberGroup(hash: string, teamId: string, input: TeamMemberGroupInput): Promise<Result<TeamContext>>;
  deleteMemberGroup(hash: string, teamId: string, groupId: string, input: TeamMemberGroupDeleteInput): Promise<Result<TeamContext>>;
}
