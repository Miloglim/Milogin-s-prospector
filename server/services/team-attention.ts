import type { TokenPort } from '../core/auth';
import { failure } from '../core/crm';
import {
  TEAM_ATTENTION_LIMITS,
  TEAM_ATTENTION_REASONS,
  TEAM_ATTENTION_STATUSES,
  type TeamAttentionCreate,
  type TeamAttentionQuery,
  type TeamAttentionRepository,
  type TeamAttentionTransition,
} from '../core/team-attention';
import { MAIL_PRIORITIES } from '../core/mail-analysis';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function text(value: unknown, maximum: number, minimum = 1): value is string {
  return typeof value === 'string' && value.trim().length >= minimum && value.trim().length <= maximum && !value.includes('\0');
}

function optionalText(value: unknown, maximum: number): value is string | undefined {
  return value === undefined || text(value, maximum);
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function query(value: unknown): TeamAttentionQuery | undefined {
  if (!record(value) || !keys(value, ['status', 'reason', 'targetMemberUserId', 'limit', 'offset'])) return undefined;
  if (value.status !== undefined && !TEAM_ATTENTION_STATUSES.includes(value.status as never)) return undefined;
  if (value.reason !== undefined && !TEAM_ATTENTION_REASONS.includes(value.reason as never)) return undefined;
  if (value.targetMemberUserId !== undefined && !uuid(value.targetMemberUserId)) return undefined;
  if (!Number.isSafeInteger(value.limit) || Number(value.limit) < 1 || Number(value.limit) > TEAM_ATTENTION_LIMITS.pageMax) return undefined;
  if (!Number.isSafeInteger(value.offset) || Number(value.offset) < 0) return undefined;
  return value as unknown as TeamAttentionQuery;
}

function createInput(value: unknown): TeamAttentionCreate | undefined {
  if (!record(value) || !keys(value, ['targetMemberUserId', 'customerId', 'contactId', 'mailEventId', 'analysisId', 'reason', 'priority', 'note', 'idempotencyKey'])) return undefined;
  if (!uuid(value.targetMemberUserId) || !uuid(value.customerId) || !Number.isSafeInteger(value.contactId) || Number(value.contactId) < 1) return undefined;
  if (value.mailEventId !== undefined && !uuid(value.mailEventId) || value.analysisId !== undefined && !uuid(value.analysisId)) return undefined;
  if (!TEAM_ATTENTION_REASONS.includes(value.reason as never) || !MAIL_PRIORITIES.includes(value.priority as never)) return undefined;
  if (!optionalText(value.note, TEAM_ATTENTION_LIMITS.note) || !text(value.idempotencyKey, TEAM_ATTENTION_LIMITS.key)) return undefined;
  return value as unknown as TeamAttentionCreate;
}

function transition(value: unknown): TeamAttentionTransition | undefined {
  if (!record(value) || !keys(value, ['action', 'expectedVersion', 'idempotencyKey', 'result']) || !['acknowledge', 'dismiss', 'resolve'].includes(String(value.action))) return undefined;
  if (!Number.isSafeInteger(value.expectedVersion) || Number(value.expectedVersion) < 1 || !text(value.idempotencyKey, TEAM_ATTENTION_LIMITS.key)) return undefined;
  if (!optionalText(value.result, TEAM_ATTENTION_LIMITS.result)) return undefined;
  if (value.action === 'resolve' && !text(value.result, TEAM_ATTENTION_LIMITS.result)) return undefined;
  return value as unknown as TeamAttentionTransition;
}

export function createTeamAttentionService(repo: TeamAttentionRepository, tokens: TokenPort) {
  const run = <T>(token: string, action: (hash: string) => Promise<import('../core/crm').Result<T>>): Promise<import('../core/crm').Result<T>> =>
    TOKEN.test(token) ? action(tokens.hash(token)) : Promise.resolve(failure('UNAUTHORIZED', '会话无效') as import('../core/crm').Result<T>);
  return {
    list(token: string, value: unknown) {
      const parsed = query(value);
      return parsed ? run(token, hash => repo.list(hash, parsed)) : Promise.resolve(failure('INVALID_INPUT', '关注项查询参数无效'));
    },
    create(token: string, value: unknown) {
      const parsed = createInput(value);
      return parsed ? run(token, hash => repo.create(hash, parsed)) : Promise.resolve(failure('INVALID_INPUT', '关注项参数无效'));
    },
    transition(token: string, itemId: string, action: TeamAttentionTransition['action'], value: unknown) {
      const parsed = transition(value);
      if (!parsed || !UUID.test(itemId) || parsed.action !== action) return Promise.resolve(failure('INVALID_INPUT', '关注项状态参数无效'));
      return run(token, hash => repo.transition(hash, { ...parsed, itemId }));
    },
  };
}

export type TeamAttentionService = ReturnType<typeof createTeamAttentionService>;
