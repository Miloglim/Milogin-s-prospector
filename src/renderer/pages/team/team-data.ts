import { useQuery } from '@tanstack/react-query';
import {
  CENTER_CONTACT_LIMITS,
  ONLINE_CHANNELS,
  centerContactQuery,
  type CenterContactPage,
  type Result,
  type TaskPage,
  type TeamContext,
  type TeamCreateInput,
  type TeamCreateReceipt,
  type TeamDetail,
  type TeamDirectoryPage,
  type TeamDirectConversationPage,
  type TeamDirectConversationQuery,
  type TeamDirectMessage,
  type TeamDirectMessagePage,
  type TeamDirectMessageQuery,
  type TeamDirectMessageSend,
  type TeamFileMeta,
  type TeamFileOpenResult,
  type TeamFileUpload,
  type TeamConversationArchiveInput,
  type TeamArchiveMeta,
  type TeamAttentionCreate,
  type TeamAttentionItem,
  type TeamMessageReadCommand,
  type TeamMessageReadReceipt,
  type TeamMessageUnreadCommand,
  type TeamDissolveInput,
  type TeamInvitationDecision,
  type TeamInviteInput,
  type TeamLeaderInput,
  type TeamMemberAdjustmentInput,
  type TeamMemberCandidatePage,
  type TeamMemberGroupDeleteInput,
  type TeamMemberGroupInput,
  type TeamMoveInput,
  type TeamMonitoringOverview,
  type TeamMonitoringQuery,
  type TeamMonitoringMemberDetail,
  type TeamMonitoringContactSummary,
  type TeamPresenceView,
  type TeamUnitType,
} from '../../../shared/online-crm';
import type { TeamContactScope } from '../../../shared/team-workspace';
import { useIdentity } from '../../IdentityContext';

const TEAM_CONTACT_PAGE_SIZE = CENTER_CONTACT_LIMITS.page;
const TEAM_TASK_PAGE_SIZE = 25;
const TEAM_MESSAGE_PAGE_SIZE = 100;

function permissionScope(identity: ReturnType<typeof useIdentity>['identity']): string {
  return JSON.stringify([
    (identity?.crmRoles ?? []).slice().sort(),
    identity?.crmCapabilities?.slice().sort(),
    identity?.identityAdmin,
    identity?.mustChangePassword,
  ]);
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<Result<T>> {
  try {
    return await window.api.invoke(channel, ...args) as Result<T>;
  } catch {
    return { ok: false, error: { code: 'UNAVAILABLE', message: '中心服务暂不可用' } };
  }
}

export interface TeamContactPageOptions { attentionOnly?: boolean; }

export function useTeamContactPage(scope: TeamContactScope, search: string, page: number, pageSize: number = TEAM_CONTACT_PAGE_SIZE, options: TeamContactPageOptions = {}) {
  const { identity, baseUrl, status } = useIdentity();
  const attentionOnly = options.attentionOnly === true;
  const query = centerContactQuery({ scope, search, limit: pageSize, offset: (page - 1) * pageSize, ...(attentionOnly ? { attentionOnly: true } : {}) });
  const active = !!identity && ['authenticated', 'offline'].includes(status);
  return useQuery({
    queryKey: ['center-contacts', 'team', baseUrl, identity?.userId, permissionScope(identity), scope, search, page, pageSize, attentionOnly],
    enabled: active && query.ok,
    queryFn: () => query.ok ? invoke<CenterContactPage>(ONLINE_CHANNELS.CONTACT_LIST, query.data) : Promise.resolve(query),
  });
}

export function useTeamContext(enabled = true) {
  const { identity, baseUrl, status } = useIdentity();
  return useQuery({
    queryKey: ['team-context', baseUrl, identity?.userId, permissionScope(identity)],
    enabled: enabled && !!identity && status === 'authenticated',
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnReconnect: true,
    queryFn: () => invoke<TeamContext>(ONLINE_CHANNELS.TEAM_CONTEXT, undefined),
  });
}

export function useTeamDetail(teamId: string | null, enabled = true) {
  const { identity, baseUrl, status } = useIdentity();
  return useQuery({
    queryKey: ['team-detail', baseUrl, identity?.userId, permissionScope(identity), teamId],
    enabled: enabled && !!teamId && !!identity && status === 'authenticated',
    queryFn: async (): Promise<Result<TeamDetail>> => teamId ? invoke<TeamDetail>(ONLINE_CHANNELS.TEAM_DETAIL, teamId) : { ok: false, error: { code: 'INVALID_INPUT', message: '团队编号无效' } },
  });
}

export function useTeamMessages(teamId: string | null, memberUserId: string | null, enabled = true) {
  const { identity, baseUrl, status } = useIdentity();
  const active = !!identity && status === 'authenticated';
  return useQuery({
    queryKey: ['team-messages', baseUrl, identity?.userId, permissionScope(identity), teamId, memberUserId, TEAM_MESSAGE_PAGE_SIZE],
    enabled: enabled && active && !!teamId && !!memberUserId,
    staleTime: 0,
    queryFn: async (): Promise<Result<TeamDirectMessagePage>> => {
      if (!teamId || !memberUserId) return { ok: false, error: { code: 'INVALID_INPUT', message: '私聊对象无效' } };
      const query: TeamDirectMessageQuery = { teamId, memberUserId, limit: TEAM_MESSAGE_PAGE_SIZE };
      return invoke<TeamDirectMessagePage>(ONLINE_CHANNELS.TEAM_MESSAGES, query);
    },
  });
}

export function useTeamPresence(teamId: string | null, memberUserId: string | null, enabled = true) {
  const { identity, baseUrl, status } = useIdentity();
  const active = !!identity && status === 'authenticated';
  return useQuery({
    queryKey: ['team-presence', baseUrl, identity?.userId, permissionScope(identity), teamId, memberUserId],
    enabled: enabled && active && !!teamId && !!memberUserId,
    staleTime: 0,
    refetchInterval: 15_000,
    queryFn: async (): Promise<Result<TeamPresenceView>> => {
      if (!teamId || !memberUserId) return { ok: false, error: { code: 'INVALID_INPUT', message: '成员状态参数无效' } };
      return invoke<TeamPresenceView>(ONLINE_CHANNELS.TEAM_PRESENCE, { teamId, memberUserId });
    },
  });
}

export function useTeamConversations(teamId: string | null, enabled = true) {
  const { identity, baseUrl, status } = useIdentity();
  const active = !!identity && status === 'authenticated';
  return useQuery({
    queryKey: ['team-conversations', baseUrl, identity?.userId, permissionScope(identity), teamId, TEAM_MESSAGE_PAGE_SIZE],
    enabled: enabled && active && !!teamId,
    staleTime: 0,
    queryFn: async (): Promise<Result<TeamDirectConversationPage>> => {
      if (!teamId) return { ok: false, error: { code: 'INVALID_INPUT', message: '团队编号无效' } };
      const query: TeamDirectConversationQuery = { teamId, limit: TEAM_MESSAGE_PAGE_SIZE };
      return invoke<TeamDirectConversationPage>(ONLINE_CHANNELS.TEAM_CONVERSATIONS, query);
    },
  });
}

export function useTeamDirectory(enabled = true) {
  const { identity, baseUrl, status } = useIdentity();
  const active = !!identity && status === 'authenticated';
  return useQuery({
    queryKey: ['team-directory', baseUrl, identity?.userId, permissionScope(identity)],
    enabled: enabled && active,
    staleTime: 0,
    refetchOnMount: 'always',
    queryFn: (): Promise<Result<TeamDirectoryPage>> => invoke<TeamDirectoryPage>(ONLINE_CHANNELS.TEAM_DIRECTORY, { limit: 100 }),
  });
}

export function useTeamMonitoringMember(userId: string | null, enabled = true, limit = 10) {
  const { identity, baseUrl, status } = useIdentity();
  return useQuery({
    queryKey: ['team-monitoring-member', baseUrl, identity?.userId, permissionScope(identity), userId, limit],
    enabled: enabled && !!userId && !!identity && status === 'authenticated',
    queryFn: async (): Promise<Result<TeamMonitoringMemberDetail>> => userId
      ? invoke<TeamMonitoringMemberDetail>(ONLINE_CHANNELS.TEAM_MONITORING_MEMBER, userId, limit, 0)
      : { ok: false, error: { code: 'INVALID_INPUT', message: '成员编号无效' } },
  });
}

export function useTeamMonitoringOverview(teamId: string | null, enabled = true) {
  const { identity, baseUrl, status } = useIdentity();
  return useQuery({
    queryKey: ['team-monitoring-overview', baseUrl, identity?.userId, permissionScope(identity), teamId],
    enabled: enabled && !!teamId && !!identity && status === 'authenticated',
    queryFn: async (): Promise<Result<TeamMonitoringOverview>> => {
      if (!teamId) return { ok: false, error: { code: 'INVALID_INPUT', message: '团队编号无效' } };
      const query: TeamMonitoringQuery = { teamId, limit: 100, offset: 0, unitLimit: 100, unitOffset: 0 };
      return invoke<TeamMonitoringOverview>(ONLINE_CHANNELS.TEAM_MONITORING, query);
    },
  });
}

export function useTeamMonitoringContact(contactId: number | null, customerId: string | null, enabled = true) {
  const { identity, baseUrl, status } = useIdentity();
  return useQuery({
    queryKey: ['team-monitoring-contact', baseUrl, identity?.userId, permissionScope(identity), contactId, customerId],
    enabled: enabled && status === 'authenticated' && !!contactId && !!customerId,
    staleTime: 0,
    queryFn: async (): Promise<Result<TeamMonitoringContactSummary>> => {
      if (!contactId || !customerId) return { ok: false, error: { code: 'INVALID_INPUT', message: '客户参数无效' } };
      return invoke<TeamMonitoringContactSummary>(ONLINE_CHANNELS.TEAM_MONITORING_CONTACT, contactId, customerId, 20, 0);
    },
  });
}

export function useTeamCandidates(search: string, enabled: boolean, role: 'member' | 'leader' = 'member', unitType: TeamUnitType = 'sales_team', purpose: 'invite' | 'create' = 'invite') {
  const { identity, baseUrl, status } = useIdentity();
  return useQuery({
    queryKey: ['team-candidates', baseUrl, identity?.userId, permissionScope(identity), role, unitType, purpose, search],
    enabled: !!identity && status === 'authenticated' && enabled,
    queryFn: () => invoke<TeamMemberCandidatePage>(ONLINE_CHANNELS.TEAM_CANDIDATES, { search, limit: 50, offset: 0, role, unitType, ...(purpose === 'create' ? { purpose } : {}) }),
  });
}

export function useTeamOpenTasks(enabled = true, limit = TEAM_TASK_PAGE_SIZE) {
  const { identity, baseUrl, status } = useIdentity();
  const active = !!identity && ['authenticated', 'offline'].includes(status);
  const queryFn = async (): Promise<Result<TaskPage>> => {
    const mine = await invoke<TaskPage>(ONLINE_CHANNELS.TASK_LIST, { status: 'open', mine: true, limit, offset: 0 });
    if (mine.ok || mine.error.code !== 'INVALID_INPUT') return mine;
    // 兼容尚未加载 mine 参数的中心；新版中心不会走这条降级路径。
    const legacy = await invoke<TaskPage>(ONLINE_CHANNELS.TASK_LIST, { status: 'open', limit: 100, offset: 0 });
    if (!legacy.ok) return legacy;
    const items = legacy.data.items.filter(task => task.responsibleUserId === identity?.userId);
    return { ok: true, data: { items: items.slice(0, limit), total: items.length } };
  };
  return useQuery({
    queryKey: ['team-open-tasks', baseUrl, identity?.userId, permissionScope(identity), 'mine', limit],
    enabled: active && enabled,
    queryFn,
  });
}

export const teamActions = {
  create: (input: TeamCreateInput) => invoke<TeamCreateReceipt>(ONLINE_CHANNELS.TEAM_CREATE, input),
  invite: (teamId: string, input: TeamInviteInput) => invoke<TeamContext>(ONLINE_CHANNELS.TEAM_INVITE, teamId, input),
  accept: (invitationId: string, input: TeamInvitationDecision) => invoke<TeamContext>(ONLINE_CHANNELS.TEAM_INVITATION_ACCEPT, invitationId, input),
  decline: (invitationId: string, input: TeamInvitationDecision) => invoke<TeamContext>(ONLINE_CHANNELS.TEAM_INVITATION_DECLINE, invitationId, input),
  cancel: (invitationId: string, input: TeamInvitationDecision) => invoke<TeamContext>(ONLINE_CHANNELS.TEAM_INVITATION_CANCEL, invitationId, input),
  move: (teamId: string, input: TeamMoveInput) => invoke<TeamContext>(ONLINE_CHANNELS.TEAM_MOVE, teamId, input),
  dissolve: (teamId: string, input: TeamDissolveInput) => invoke<TeamContext>(ONLINE_CHANNELS.TEAM_DISSOLVE, teamId, input),
  assignLeader: (teamId: string, input: TeamLeaderInput) => invoke<TeamContext>(ONLINE_CHANNELS.TEAM_LEADER, teamId, input),
  adjustMember: (teamId: string, input: TeamMemberAdjustmentInput) => invoke<TeamContext>(ONLINE_CHANNELS.TEAM_MEMBER, teamId, input),
  saveMemberGroup: (teamId: string, input: TeamMemberGroupInput) => invoke<TeamContext>(ONLINE_CHANNELS.TEAM_GROUP_SAVE, teamId, input),
  deleteMemberGroup: (teamId: string, groupId: string, input: TeamMemberGroupDeleteInput) => invoke<TeamContext>(ONLINE_CHANNELS.TEAM_GROUP_DELETE, teamId, groupId, input),
  sendMessage: (input: TeamDirectMessageSend) => invoke<TeamDirectMessage>(ONLINE_CHANNELS.TEAM_MESSAGE_SEND, input),
  messages: (query: TeamDirectMessageQuery) => invoke<TeamDirectMessagePage>(ONLINE_CHANNELS.TEAM_MESSAGES, query),
  markMessagesRead: (input: TeamMessageReadCommand) => invoke<TeamMessageReadReceipt>(ONLINE_CHANNELS.TEAM_MESSAGE_READ, input),
  markMessagesUnread: (input: TeamMessageUnreadCommand) => invoke<TeamMessageReadReceipt>(ONLINE_CHANNELS.TEAM_MESSAGE_UNREAD, input),
  uploadFile: (input: TeamFileUpload) => invoke<TeamFileMeta>(ONLINE_CHANNELS.TEAM_FILE_UPLOAD, input),
  openFile: (fileId: string) => invoke<{ opened: boolean }>(ONLINE_CHANNELS.TEAM_FILE_OPEN, fileId),
  archiveConversation: (input: TeamConversationArchiveInput) => invoke<TeamArchiveMeta>(ONLINE_CHANNELS.TEAM_ARCHIVE, input),
  createAttention: (input: TeamAttentionCreate) => invoke<TeamAttentionItem>(ONLINE_CHANNELS.TEAM_ATTENTION_CREATE, input),
};

export const TEAM_DATA_LIMITS = { summaryContactPage: 8, summaryTaskPage: 8 } as const;

type TeamChatMemory = { ownerUserId: string; teamId: string | null; memberId: string | null };
let teamChatMemory: TeamChatMemory | null = null;

/** Session-only chat selection: survives page remounts but not an application restart. */
export function readTeamChatMemory(ownerUserId: string | null | undefined): Pick<TeamChatMemory, 'teamId' | 'memberId'> {
  return ownerUserId && teamChatMemory?.ownerUserId === ownerUserId
    ? { teamId: teamChatMemory.teamId, memberId: teamChatMemory.memberId }
    : { teamId: null, memberId: null };
}

export function rememberTeamChat(ownerUserId: string | null | undefined, patch: Partial<Pick<TeamChatMemory, 'teamId' | 'memberId'>>): void {
  if (!ownerUserId) return;
  const current = readTeamChatMemory(ownerUserId);
  teamChatMemory = { ownerUserId, teamId: current.teamId, memberId: current.memberId, ...patch };
}

export function clearTeamChatMemory(): void {
  teamChatMemory = null;
}

/** Team leaders are the stable first row in every account list. */
export function compareTeamMemberOrder(left: { role: 'leader' | 'member'; displayName: string }, right: { role: 'leader' | 'member'; displayName: string }): number {
  if (left.role !== right.role) return left.role === 'leader' ? -1 : 1;
  return left.displayName.localeCompare(right.displayName, 'zh-CN');
}

export function orderTeamMembers<T extends { role: 'leader' | 'member'; displayName: string }>(members: readonly T[]): T[] {
  return [...members].sort(compareTeamMemberOrder);
}
