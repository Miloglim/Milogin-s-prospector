import type { TokenPort } from '../core/auth';
import { failure, type Result } from '../core/crm';
import {
  TEAM_MONITORING_LIMITS,
  type TeamMonitoringQuery,
  type TeamMonitoringRepository,
} from '../core/team-monitoring';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function page(value: unknown): { limit: number; offset: number } | undefined {
  if (!record(value) || !keys(value, ['limit', 'offset'])) return undefined;
  const limit = value.limit ?? TEAM_MONITORING_LIMITS.mailPage;
  const offset = value.offset ?? 0;
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > TEAM_MONITORING_LIMITS.pageMax
    || !Number.isSafeInteger(offset) || Number(offset) < 0) return undefined;
  return { limit: Number(limit), offset: Number(offset) };
}

function overviewQuery(value: unknown): TeamMonitoringQuery | undefined {
  if (!record(value) || !keys(value, ['teamId', 'memberUserId', 'limit', 'offset', 'unitLimit', 'unitOffset'])) return undefined;
  if (value.teamId !== undefined && (typeof value.teamId !== 'string' || !UUID.test(value.teamId))) return undefined;
  if (value.memberUserId !== undefined && (typeof value.memberUserId !== 'string' || !UUID.test(value.memberUserId))) return undefined;
  const limit = value.limit ?? TEAM_MONITORING_LIMITS.page;
  const offset = value.offset ?? 0;
  const unitLimit = value.unitLimit ?? TEAM_MONITORING_LIMITS.unitPage;
  const unitOffset = value.unitOffset ?? 0;
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > TEAM_MONITORING_LIMITS.pageMax
    || !Number.isSafeInteger(unitLimit) || Number(unitLimit) < 1 || Number(unitLimit) > TEAM_MONITORING_LIMITS.pageMax
    || !Number.isSafeInteger(offset) || Number(offset) < 0
    || !Number.isSafeInteger(unitOffset) || Number(unitOffset) < 0) return undefined;
  return {
    ...(value.teamId ? { teamId: value.teamId } : {}),
    ...(value.memberUserId ? { memberUserId: value.memberUserId } : {}),
    limit: Number(limit), offset: Number(offset), unitLimit: Number(unitLimit), unitOffset: Number(unitOffset),
  };
}

function contactQuery(value: unknown): { customerId: string; limit: number; offset: number } | undefined {
  if (!record(value) || !keys(value, ['customerId', 'limit', 'offset']) || typeof value.customerId !== 'string' || !UUID.test(value.customerId)) return undefined;
  const paging = page({ limit: value.limit, offset: value.offset });
  return paging ? { customerId: value.customerId, ...paging } : undefined;
}

function mailQuery(value: unknown): { contactId: number; customerId: string } | undefined {
  if (!record(value) || !keys(value, ['contactId', 'customerId']) || typeof value.customerId !== 'string' || !UUID.test(value.customerId)) return undefined;
  if (!Number.isSafeInteger(value.contactId) || Number(value.contactId) < 1) return undefined;
  return { contactId: Number(value.contactId), customerId: value.customerId };
}

export function createTeamMonitoringService(repo: TeamMonitoringRepository, tokens: TokenPort) {
  const run = <T>(token: string, action: (hash: string) => Promise<Result<T>>): Promise<Result<T>> =>
    TOKEN.test(token) ? action(tokens.hash(token)) : Promise.resolve(failure('UNAUTHORIZED', '会话无效') as Result<T>);
  return {
    overview(token: string, value: unknown) {
      const parsed = overviewQuery(value);
      return parsed ? run(token, hash => repo.overview(hash, parsed)) : Promise.resolve(failure('INVALID_INPUT', '团队监控查询参数无效'));
    },
    member(token: string, userId: string, value: unknown) {
      const parsed = page(value);
      if (!UUID.test(userId) || !parsed) return Promise.resolve(failure('INVALID_INPUT', '成员监控查询参数无效'));
      return run(token, hash => repo.member(hash, userId, parsed.limit, parsed.offset));
    },
    contact(token: string, contactId: string, value: unknown) {
      const parsed = contactQuery(value);
      if (!/^\d+$/.test(contactId) || !Number.isSafeInteger(Number(contactId)) || Number(contactId) < 1 || !parsed) {
        return Promise.resolve(failure('INVALID_INPUT', '联系人监控查询参数无效'));
      }
      return run(token, hash => repo.contact(hash, Number(contactId), parsed.customerId, parsed.limit, parsed.offset));
    },
    mail(token: string, eventId: string, value: unknown) {
      const parsed = mailQuery(value);
      if (!UUID.test(eventId) || !parsed) return Promise.resolve(failure('INVALID_INPUT', '邮件监控查询参数无效'));
      return run(token, hash => repo.mail(hash, eventId, parsed.contactId, parsed.customerId));
    },
  };
}

export type TeamMonitoringService = ReturnType<typeof createTeamMonitoringService>;
