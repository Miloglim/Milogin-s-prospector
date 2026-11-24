import type { Result } from './crm';
import type { OrganizationUnitKind } from './organization';

export const TEAM_ROUTES = {
  context: '/api/crm/team-context',
  candidates: '/api/crm/team-invite-candidates',
  teams: '/api/crm/teams',
  invitations: '/api/crm/team-invitations',
  messages: '/api/crm/team-messages',
  messagesRead: '/api/crm/team-messages/read',
  messagesUnread: '/api/crm/team-messages/unread',
  conversations: '/api/crm/team-conversations',
  directory: '/api/crm/team-directory',
  presence: '/api/crm/team-presence',
  files: '/api/crm/team-files',
  archive: '/api/crm/team-conversations/archive',
  events: '/api/crm/team-events',
} as const;

export function isTeamRoute(path: string): boolean {
  return Object.values(TEAM_ROUTES).some(route => path === route || path.startsWith(`${route}/`));
}

export const TEAM_LIMITS = {
  name: 80,
  groupName: 40,
  text: 500,
  page: 50,
  pageMax: 100,
  inviteBatch: 20,
  groupMembers: 100,
  bodyBytes: 8192,
  fileBodyBytes: 12 * 1024 * 1024,
  key: 128,
  messageBody: 2000,
  fileBytes: 8 * 1024 * 1024,
  filename: 240,
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
  return unitType === undefined || isTeamUnitType(unitType);
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
  leaderName?: string;
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

export interface TeamDirectMessage {
  messageId: string;
  teamId: string;
  senderUserId: string;
  senderName: string;
  recipientUserId: string;
  recipientName: string;
  body: string;
  kind: TeamDirectMessageKind;
  payload: TeamFilePayload | TeamEmailReferencePayload | null;
  createdAt: string;
  mine: boolean;
}

export type TeamDirectMessageKind = 'text' | 'attachment' | 'email_ref';

export interface TeamFilePayload {
  fileId: string;
  filename: string;
  mimeType: string;
  bytes: number;
  sha256: string;
}

export interface TeamEmailReferencePayload {
  messageKey: string;
  subject: string;
  from: string;
  to: string[];
  occurredAt: string;
  summary?: string;
  excerpt?: string;
  customerId?: string;
  contactId?: number;
}

export interface TeamFileUpload {
  teamId: string;
  filename: string;
  mimeType: string;
  base64: string;
  idempotencyKey: string;
}

export interface TeamFileMeta extends TeamFilePayload {
  teamId: string;
  createdAt: string;
}

export interface TeamConversationArchiveInput {
  teamId: string;
  memberUserId: string;
  from?: string;
  to?: string;
  idempotencyKey: string;
}

export interface TeamArchiveMeta extends TeamFileMeta {
  messageCount: number;
}

export type TeamEventType = 'message.created' | 'message.read' | 'message.unread';

export interface TeamEvent {
  eventId: string;
  type: TeamEventType;
  teamId: string;
  peerUserId: string;
  messageId: string | null;
  occurredAt: string;
}

export interface TeamDirectMessageQuery {
  teamId?: string;
  memberUserId: string;
  limit: number;
  beforeMessageId?: string;
}

export interface TeamDirectMessageSend {
  teamId?: string;
  recipientUserId: string;
  body: string;
  kind?: TeamDirectMessageKind;
  fileId?: string;
  payload?: TeamEmailReferencePayload;
  idempotencyKey: string;
}

export interface TeamDirectMessagePage {
  items: TeamDirectMessage[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface TeamMessageReadCommand {
  teamId: string;
  memberUserId: string;
  throughMessageId?: string;
  idempotencyKey: string;
}

export interface TeamMessageUnreadCommand {
  teamId: string;
  memberUserId: string;
  messageId: string;
  idempotencyKey: string;
}

export interface TeamMessageReadReceipt {
  lastReadAt: string | null;
  unreadCount: number;
}

export type TeamPresenceState = 'online' | 'unread' | 'offline';

export interface TeamPresenceQuery {
  teamId: string;
  memberUserId: string;
}

export interface TeamPresenceView {
  state: TeamPresenceState;
  lastSeenAt: string | null;
  unread: boolean;
}

export interface TeamDirectConversation {
  userId: string;
  teamId: string;
  displayName: string;
  email: string | null;
  manager: boolean;
  lastMessage: string;
  lastMessageAt: string;
  mine: boolean;
  lastMessageId: string;
  lastReadAt: string | null;
  unreadCount: number;
  presence: 'online' | 'offline';
}

export interface TeamDirectConversationQuery {
  teamId?: string;
  limit: number;
}

export interface TeamDirectConversationPage {
  items: TeamDirectConversation[];
}

export interface TeamDirectoryEntry {
  userId: string;
  displayName: string;
  email: string | null;
  teamId: string | null;
  teamName: string | null;
  manager: boolean;
  presence: 'online' | 'offline';
  unreadCount: number;
}

export interface TeamDirectoryPage {
  items: TeamDirectoryEntry[];
}

export interface TeamDirectoryQuery {
  limit: number;
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
  currentUser(hash: string): Promise<Result<string>>;
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
  directory(hash: string, query: TeamDirectoryQuery): Promise<Result<TeamDirectoryPage>>;
  conversations(hash: string, query: TeamDirectConversationQuery): Promise<Result<TeamDirectConversationPage>>;
  messages(hash: string, query: TeamDirectMessageQuery): Promise<Result<TeamDirectMessagePage>>;
  markMessagesRead(hash: string, input: TeamMessageReadCommand): Promise<Result<TeamMessageReadReceipt>>;
  markMessagesUnread(hash: string, input: TeamMessageUnreadCommand): Promise<Result<TeamMessageReadReceipt>>;
  presence(hash: string, query: TeamPresenceQuery): Promise<Result<TeamPresenceView>>;
  uploadFile(hash: string, input: TeamFileUpload): Promise<Result<TeamFileMeta>>;
  readFile(hash: string, fileId: string): Promise<Result<{ meta: TeamFileMeta; data: Uint8Array }>>;
  archiveConversation(hash: string, input: TeamConversationArchiveInput): Promise<Result<TeamArchiveMeta>>;
  sendMessage(hash: string, input: TeamDirectMessageSend): Promise<Result<TeamDirectMessage>>;
}
