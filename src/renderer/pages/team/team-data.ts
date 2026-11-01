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
  type TeamDissolveInput,
  type TeamInvitationDecision,
  type TeamInviteInput,
  type TeamLeaderInput,
  type TeamMemberAdjustmentInput,
  type TeamMemberCandidatePage,
  type TeamMemberGroupDeleteInput,
  type TeamMemberGroupInput,
  type TeamMoveInput,
  type TeamUnitType,
} from '../../../shared/online-crm';
import type { TeamContactScope } from '../../../shared/team-workspace';
import { useIdentity } from '../../IdentityContext';

const TEAM_CONTACT_PAGE_SIZE = CENTER_CONTACT_LIMITS.page;
const TEAM_TASK_PAGE_SIZE = 25;

function permissionScope(identity: ReturnType<typeof useIdentity>['identity']): string {
  return JSON.stringify([
    identity?.crmRoles.slice().sort(),
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

export function useTeamContactPage(scope: TeamContactScope, search: string, page: number, pageSize: number = TEAM_CONTACT_PAGE_SIZE) {
  const { identity, baseUrl, status } = useIdentity();
  const query = centerContactQuery({ scope, search, limit: pageSize, offset: (page - 1) * pageSize });
  const active = !!identity && ['authenticated', 'offline'].includes(status);
  return useQuery({
    queryKey: ['center-contacts', 'team', baseUrl, identity?.userId, permissionScope(identity), scope, search, page, pageSize],
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

export function useTeamCandidates(search: string, enabled: boolean, role: 'member' | 'leader' = 'member', unitType: TeamUnitType = 'sales_team') {
  const { identity, baseUrl, status } = useIdentity();
  return useQuery({
    queryKey: ['team-candidates', baseUrl, identity?.userId, permissionScope(identity), role, unitType, search],
    enabled: !!identity && status === 'authenticated' && enabled,
    queryFn: () => invoke<TeamMemberCandidatePage>(ONLINE_CHANNELS.TEAM_CANDIDATES, { search, limit: 50, offset: 0, role, unitType }),
  });
}

export function useTeamOpenTasks(enabled = true, limit = TEAM_TASK_PAGE_SIZE) {
  const { identity, baseUrl, status } = useIdentity();
  const active = !!identity && ['authenticated', 'offline'].includes(status);
  return useQuery({
    queryKey: ['team-open-tasks', baseUrl, identity?.userId, permissionScope(identity), limit],
    enabled: active && enabled,
    queryFn: () => invoke<TaskPage>(ONLINE_CHANNELS.TASK_LIST, { status: 'open', limit, offset: 0 }),
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
};

export const TEAM_DATA_LIMITS = { summaryContactPage: 8, summaryTaskPage: 8 } as const;
