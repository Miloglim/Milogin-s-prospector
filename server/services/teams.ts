import type { TokenPort } from '../core/auth';
import { failure } from '../core/crm';
import {
  TEAM_LIMITS,
  type TeamCreateInput,
  type TeamDissolveInput,
  type TeamInvitationDecision,
  type TeamInviteInput,
  type TeamLeaderInput,
  type TeamMemberAdjustmentInput,
  type TeamMemberGroupDeleteInput,
  type TeamMemberGroupInput,
  type TeamMemberCandidateQuery,
  type TeamDirectConversationQuery,
  type TeamDirectoryQuery,
  type TeamDirectMessageQuery,
  type TeamMessageReadCommand,
  type TeamMessageUnreadCommand,
  type TeamPresenceQuery,
  type TeamDirectMessageSend,
  type TeamFileUpload,
  type TeamConversationArchiveInput,
  type TeamEvent,
  type TeamMoveInput,
  type TeamRepository,
} from '../core/teams';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

type TeamEventListener = (event: TeamEvent) => void;

function createTeamEventHub() {
  const listeners = new Map<string, Set<TeamEventListener>>();
  let sequence = 0;
  return {
    subscribe(userId: string, listener: TeamEventListener): () => void {
      const set = listeners.get(userId) ?? new Set<TeamEventListener>();
      set.add(listener);
      listeners.set(userId, set);
      return () => { set.delete(listener); if (!set.size) listeners.delete(userId); };
    },
    publish(type: TeamEvent['type'], recipients: string[], teamId: string, peerUserId: string, messageId: string | null): void {
      const event: TeamEvent = { eventId: `${Date.now()}-${++sequence}`, type, teamId, peerUserId, messageId, occurredAt: new Date().toISOString() };
      for (const userId of new Set(recipients)) for (const listener of listeners.get(userId) ?? []) { try { listener(event); } catch { /* subscriber is already closing */ } }
    },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, allowed: readonly string[], optional: readonly string[] = []): boolean {
  const known = new Set([...allowed, ...optional]);
  return Object.keys(value).every(key => known.has(key));
}

function text(value: unknown, maximum: number, minimum = 1): value is string {
  return typeof value === 'string' && value.trim().length >= minimum && value.trim().length <= maximum;
}

function userIds(value: unknown, maximum: number = TEAM_LIMITS.inviteBatch): value is string[] {
  return Array.isArray(value) && value.length <= maximum && new Set(value).size === value.length && value.every(userId => typeof userId === 'string' && UUID.test(userId));
}

function idempotency(value: unknown): value is string {
  return text(value, TEAM_LIMITS.key);
}

function unitType(value: unknown): value is 'operations' | 'sales_team' | undefined {
  return value === undefined || value === 'operations' || value === 'sales_team';
}

function requiresExplicitLeader(value: Record<string, unknown>): boolean {
  return value.unitType === 'operations' || value.parentTeamId !== null;
}

function candidateQuery(value: unknown): TeamMemberCandidateQuery | undefined {
  if (value === undefined) return { search: '', limit: TEAM_LIMITS.page, offset: 0, role: 'member', unitType: 'sales_team' };
  if (!record(value) || !keys(value, ['search', 'limit', 'offset', 'role', 'unitType', 'purpose'])) return undefined;
  const search = value.search ?? '';
  const limit = value.limit ?? TEAM_LIMITS.page;
  const offset = value.offset ?? 0;
  const role = value.role ?? 'member';
  const type = value.unitType ?? 'sales_team';
  const purpose = value.purpose ?? 'invite';
  if (typeof search !== 'string' || search.length > TEAM_LIMITS.text || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > TEAM_LIMITS.pageMax || !Number.isSafeInteger(offset) || Number(offset) < 0) return undefined;
  if (!['member', 'leader'].includes(String(role)) || !['operations', 'sales_team'].includes(String(type))) return undefined;
  if (!['invite', 'create'].includes(String(purpose))) return undefined;
  if (purpose === 'create' && role !== 'member') return undefined;
  return { search: search.trim(), limit: Number(limit), offset: Number(offset), role: role as TeamMemberCandidateQuery['role'], unitType: type as TeamMemberCandidateQuery['unitType'], purpose: purpose as TeamMemberCandidateQuery['purpose'] };
}

function decision(value: unknown): TeamInvitationDecision | undefined {
  if (!record(value) || !keys(value, ['expectedVersion', 'idempotencyKey']) || !Number.isSafeInteger(value.expectedVersion) || Number(value.expectedVersion) < 1 || !idempotency(value.idempotencyKey)) return undefined;
  return { expectedVersion: Number(value.expectedVersion), idempotencyKey: value.idempotencyKey };
}

function dissolveInput(value: unknown): TeamDissolveInput | undefined {
  if (!record(value) || !keys(value, ['expectedVersion', 'idempotencyKey']) || !version(value.expectedVersion) || !idempotency(value.idempotencyKey)) return undefined;
  return value as unknown as TeamDissolveInput;
}

function version(value: unknown, allowZero = false): value is number {
  return Number.isSafeInteger(value) && Number(value) >= (allowZero ? 0 : 1);
}

function moveInput(value: unknown): TeamMoveInput | undefined {
  if (!record(value) || !keys(value, ['parentTeamId', 'expectedVersion', 'idempotencyKey']) || value.parentTeamId !== null && (typeof value.parentTeamId !== 'string' || !UUID.test(value.parentTeamId)) || !version(value.expectedVersion) || !idempotency(value.idempotencyKey)) return undefined;
  return value as unknown as TeamMoveInput;
}

function leaderInput(value: unknown): TeamLeaderInput | undefined {
  if (!record(value) || !keys(value, ['leaderUserId', 'expectedVersion', 'idempotencyKey']) || typeof value.leaderUserId !== 'string' || !UUID.test(value.leaderUserId) || !version(value.expectedVersion) || !idempotency(value.idempotencyKey)) return undefined;
  return value as unknown as TeamLeaderInput;
}

function memberInput(value: unknown): TeamMemberAdjustmentInput | undefined {
  if (!record(value) || !keys(value, ['userId', 'action', 'expectedVersion', 'idempotencyKey']) || typeof value.userId !== 'string' || !UUID.test(value.userId) || !['add', 'remove', 'leave'].includes(String(value.action)) || !version(value.expectedVersion) || !idempotency(value.idempotencyKey)) return undefined;
  return value as unknown as TeamMemberAdjustmentInput;
}

function groupInput(value: unknown): TeamMemberGroupInput | undefined {
  if (!record(value) || !keys(value, ['groupId', 'name', 'memberIds', 'expectedVersion', 'idempotencyKey']) || value.groupId !== null && (typeof value.groupId !== 'string' || !UUID.test(value.groupId)) || !text(value.name, TEAM_LIMITS.groupName, 1) || !userIds(value.memberIds, TEAM_LIMITS.groupMembers) || !version(value.expectedVersion, value.groupId === null) || !idempotency(value.idempotencyKey)) return undefined;
  return value as unknown as TeamMemberGroupInput;
}

function groupDeleteInput(value: unknown, groupId: string): TeamMemberGroupDeleteInput | undefined {
  if (!UUID.test(groupId) || !record(value) || !keys(value, ['groupId', 'expectedVersion', 'idempotencyKey']) || value.groupId !== groupId || !version(value.expectedVersion) || !idempotency(value.idempotencyKey)) return undefined;
  return value as unknown as TeamMemberGroupDeleteInput;
}

export function createTeamService(repo: TeamRepository, tokens: TokenPort) {
  const events = createTeamEventHub();
  return {
    async subscribeEvents(token: string, listener: TeamEventListener) {
      const current = await repo.currentUser(tokens.hash(token));
      return current.ok ? { ok: true as const, data: events.subscribe(current.data, listener) } : current;
    },
    context(token: string) {
      return repo.context(tokens.hash(token));
    },
    detail(token: string, teamId: string) {
      return UUID.test(teamId) ? repo.detail(tokens.hash(token), teamId) : Promise.resolve(failure('INVALID_INPUT', '团队编号无效'));
    },
    candidates(token: string, value: unknown) {
      const query = candidateQuery(value);
      return query ? repo.candidates(tokens.hash(token), query) : Promise.resolve(failure('INVALID_INPUT', '成员搜索参数无效'));
    },
    create(token: string, value: unknown) {
      if (!record(value) || !keys(value, ['name', 'parentTeamId', 'unitType', 'leaderUserId', 'inviteeUserIds', 'idempotencyKey']) || !text(value.name, TEAM_LIMITS.name, 2) || value.parentTeamId !== null && (typeof value.parentTeamId !== 'string' || !UUID.test(value.parentTeamId)) || !unitType(value.unitType) || value.leaderUserId !== undefined && (typeof value.leaderUserId !== 'string' || !UUID.test(value.leaderUserId)) || !userIds(value.inviteeUserIds) || !idempotency(value.idempotencyKey)) return Promise.resolve(failure('INVALID_INPUT', '创建团队参数无效'));
      if (requiresExplicitLeader(value) && value.leaderUserId === undefined) return Promise.resolve(failure('INVALID_INPUT', '管理角色创建组织时必须明确指定负责人'));
      return repo.create(tokens.hash(token), value as unknown as TeamCreateInput);
    },
    invite(token: string, teamId: string, value: unknown) {
      if (!UUID.test(teamId) || !record(value) || !keys(value, ['userIds', 'idempotencyKey']) || !userIds(value.userIds) || !value.userIds.length || !idempotency(value.idempotencyKey)) return Promise.resolve(failure('INVALID_INPUT', '邀请成员参数无效'));
      return repo.invite(tokens.hash(token), teamId, value as unknown as TeamInviteInput);
    },
    decide(token: string, invitationId: string, action: 'accept' | 'decline' | 'cancel', value: unknown) {
      const input = decision(value);
      return UUID.test(invitationId) && input ? repo.decide(tokens.hash(token), invitationId, action, input) : Promise.resolve(failure('INVALID_INPUT', '邀请处理参数无效'));
    },
    move(token: string, teamId: string, value: unknown) {
      const input = moveInput(value);
      return UUID.test(teamId) && input ? repo.move(tokens.hash(token), teamId, input) : Promise.resolve(failure('INVALID_INPUT', '团队移动参数无效'));
    },
    dissolve(token: string, teamId: string, value: unknown) {
      const input = dissolveInput(value);
      return UUID.test(teamId) && input ? repo.dissolve(tokens.hash(token), teamId, input) : Promise.resolve(failure('INVALID_INPUT', '团队解散参数无效'));
    },
    assignLeader(token: string, teamId: string, value: unknown) {
      const input = leaderInput(value);
      return UUID.test(teamId) && input ? repo.assignLeader(tokens.hash(token), teamId, input) : Promise.resolve(failure('INVALID_INPUT', '负责人参数无效'));
    },
    adjustMember(token: string, teamId: string, value: unknown) {
      const input = memberInput(value);
      return UUID.test(teamId) && input ? repo.adjustMember(tokens.hash(token), teamId, input) : Promise.resolve(failure('INVALID_INPUT', '成员调整参数无效'));
    },
    saveMemberGroup(token: string, teamId: string, value: unknown) {
      const input = groupInput(value);
      return UUID.test(teamId) && input ? repo.saveMemberGroup(tokens.hash(token), teamId, input) : Promise.resolve(failure('INVALID_INPUT', '展示分组参数无效'));
    },
    deleteMemberGroup(token: string, teamId: string, groupId: string, value: unknown) {
      const input = groupDeleteInput(value, groupId);
      return UUID.test(teamId) && input ? repo.deleteMemberGroup(tokens.hash(token), teamId, groupId, input) : Promise.resolve(failure('INVALID_INPUT', '展示分组参数无效'));
    },
    directory(token: string, value: unknown) {
      if (!record(value) || !keys(value, ['limit']) || !Number.isSafeInteger(value.limit) || Number(value.limit) < 1 || Number(value.limit) > TEAM_LIMITS.pageMax) return Promise.resolve(failure('INVALID_INPUT', '联系人目录参数无效'));
      return repo.directory(tokens.hash(token), value as unknown as TeamDirectoryQuery);
    },
    conversations(token: string, value: unknown) {
      if (!record(value) || !keys(value, ['limit'], ['teamId']) || value.teamId !== undefined && (typeof value.teamId !== 'string' || !UUID.test(value.teamId)) || !Number.isSafeInteger(value.limit) || Number(value.limit) < 1 || Number(value.limit) > TEAM_LIMITS.pageMax) return Promise.resolve(failure('INVALID_INPUT', '私聊列表参数无效'));
      return repo.conversations(tokens.hash(token), value as unknown as TeamDirectConversationQuery);
    },
    messages(token: string, value: unknown) {
      if (!record(value) || !keys(value, ['memberUserId', 'limit'], ['teamId', 'beforeMessageId']) || value.teamId !== undefined && (typeof value.teamId !== 'string' || !UUID.test(value.teamId)) || typeof value.memberUserId !== 'string' || !UUID.test(value.memberUserId) || !Number.isSafeInteger(value.limit) || Number(value.limit) < 1 || Number(value.limit) > TEAM_LIMITS.pageMax || value.beforeMessageId !== undefined && (typeof value.beforeMessageId !== 'string' || !UUID.test(value.beforeMessageId))) return Promise.resolve(failure('INVALID_INPUT', '私聊查询参数无效'));
      return repo.messages(tokens.hash(token), value as unknown as TeamDirectMessageQuery);
    },
    markMessagesRead(token: string, value: unknown) {
      if (!record(value) || !keys(value, ['teamId', 'memberUserId', 'idempotencyKey'], ['throughMessageId']) || typeof value.teamId !== 'string' || !UUID.test(value.teamId) || typeof value.memberUserId !== 'string' || !UUID.test(value.memberUserId) || !idempotency(value.idempotencyKey) || value.throughMessageId !== undefined && (typeof value.throughMessageId !== 'string' || !UUID.test(value.throughMessageId))) return Promise.resolve(failure('INVALID_INPUT', '已读参数无效'));
      const input = value as unknown as TeamMessageReadCommand;
      return repo.markMessagesRead(tokens.hash(token), input).then(async result => {
        if (result.ok) { const current = await repo.currentUser(tokens.hash(token)); if (current.ok) events.publish('message.read', [current.data, input.memberUserId], input.teamId, input.memberUserId, input.throughMessageId ?? null); }
        return result;
      });
    },
    markMessagesUnread(token: string, value: unknown) {
      if (!record(value) || !keys(value, ['teamId', 'memberUserId', 'messageId', 'idempotencyKey']) || typeof value.teamId !== 'string' || !UUID.test(value.teamId) || typeof value.memberUserId !== 'string' || !UUID.test(value.memberUserId) || typeof value.messageId !== 'string' || !UUID.test(value.messageId) || !idempotency(value.idempotencyKey)) return Promise.resolve(failure('INVALID_INPUT', '未读参数无效'));
      const input = value as unknown as TeamMessageUnreadCommand;
      return repo.markMessagesUnread(tokens.hash(token), input).then(async result => {
        if (result.ok) { const current = await repo.currentUser(tokens.hash(token)); if (current.ok) events.publish('message.unread', [current.data, input.memberUserId], input.teamId, input.memberUserId, input.messageId); }
        return result;
      });
    },
    presence(token: string, value: unknown) {
      if (!record(value) || !keys(value, ['teamId', 'memberUserId']) || typeof value.teamId !== 'string' || !UUID.test(value.teamId) || typeof value.memberUserId !== 'string' || !UUID.test(value.memberUserId)) return Promise.resolve(failure('INVALID_INPUT', '成员状态参数无效'));
      return repo.presence(tokens.hash(token), value as unknown as TeamPresenceQuery);
    },
    uploadFile(token: string, value: unknown) {
      if (!record(value) || !keys(value, ['teamId', 'filename', 'mimeType', 'base64', 'idempotencyKey']) || typeof value.teamId !== 'string' || !UUID.test(value.teamId) || typeof value.filename !== 'string' || typeof value.mimeType !== 'string' || typeof value.base64 !== 'string' || !idempotency(value.idempotencyKey)) return Promise.resolve(failure('INVALID_INPUT', '上传文件参数无效'));
      return repo.uploadFile(tokens.hash(token), value as unknown as TeamFileUpload);
    },
    archiveConversation(token: string, value: unknown) {
      if (!record(value) || !keys(value, ['teamId', 'memberUserId', 'idempotencyKey'], ['from', 'to']) || typeof value.teamId !== 'string' || !UUID.test(value.teamId) || typeof value.memberUserId !== 'string' || !UUID.test(value.memberUserId) || !idempotency(value.idempotencyKey) || value.from !== undefined && (typeof value.from !== 'string' || !Number.isFinite(Date.parse(value.from))) || value.to !== undefined && (typeof value.to !== 'string' || !Number.isFinite(Date.parse(value.to)))) return Promise.resolve(failure('INVALID_INPUT', '聊天归档参数无效'));
      return repo.archiveConversation(tokens.hash(token), value as unknown as TeamConversationArchiveInput);
    },
    readFile(token: string, fileId: string) {
      return UUID.test(fileId) ? repo.readFile(tokens.hash(token), fileId) : Promise.resolve(failure('INVALID_INPUT', '文件编号无效'));
    },
    sendMessage(token: string, value: unknown) {
      if (!record(value) || !keys(value, ['recipientUserId', 'body', 'idempotencyKey'], ['teamId', 'kind', 'fileId', 'payload']) || value.teamId !== undefined && (typeof value.teamId !== 'string' || !UUID.test(value.teamId)) || typeof value.recipientUserId !== 'string' || !UUID.test(value.recipientUserId) || typeof value.body !== 'string' || value.body.trim().length > TEAM_LIMITS.messageBody || value.kind !== undefined && value.kind !== 'text' && value.kind !== 'attachment' && value.kind !== 'email_ref' || value.fileId !== undefined && (typeof value.fileId !== 'string' || !UUID.test(value.fileId)) || !idempotency(value.idempotencyKey)) return Promise.resolve(failure('INVALID_INPUT', '私聊消息参数无效'));
      if (value.kind === 'email_ref' && (!record(value.payload) || typeof value.payload.messageKey !== 'string' || typeof value.payload.subject !== 'string' || typeof value.payload.from !== 'string' || !Array.isArray(value.payload.to) || !value.payload.to.every(item => typeof item === 'string') || typeof value.payload.occurredAt !== 'string')) return Promise.resolve(failure('INVALID_INPUT', '邮件引用参数无效'));
      if (value.kind !== 'attachment' && !text(value.body, TEAM_LIMITS.messageBody)) return Promise.resolve(failure('INVALID_INPUT', '私聊消息正文无效'));
      const input = value as unknown as TeamDirectMessageSend;
      return repo.sendMessage(tokens.hash(token), input).then(async result => {
        if (result.ok) { const current = await repo.currentUser(tokens.hash(token)); if (current.ok) events.publish('message.created', [current.data, input.recipientUserId], result.data.teamId, input.recipientUserId, result.data.messageId); }
        return result;
      });
    },
  };
}

export type TeamService = ReturnType<typeof createTeamService>;
