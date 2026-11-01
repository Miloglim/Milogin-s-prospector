import type { TokenPort } from '../core/auth';
import { failure, type Result } from '../core/crm';
import {
  CUSTOMER_GRADES,
  SALES_PERFORMANCE_LIMITS,
  SALES_PERFORMANCE_STRATA,
  type CustomerGradeQuery,
  type SalesPerformanceQuery,
  type SalesPerformanceRepository,
} from '../core/sales-performance';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MILLISECONDS_PER_DAY = 86400000;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function text(value: unknown, maximum: number, minimum = 1): value is string {
  return typeof value === 'string' && value.trim().length >= minimum
    && value.trim().length <= maximum && !value.includes('\0');
}

function optionalText(value: unknown, maximum: number): value is string | undefined {
  return value === undefined || text(value, maximum);
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function page(value: Record<string, unknown>): { limit: number; offset: number } | undefined {
  const limit = value.limit ?? SALES_PERFORMANCE_LIMITS.page;
  const offset = value.offset ?? 0;
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > SALES_PERFORMANCE_LIMITS.pageMax
    || !Number.isSafeInteger(offset) || Number(offset) < 0) return undefined;
  return { limit: Number(limit), offset: Number(offset) };
}

function timestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 40) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function window(value: Record<string, unknown>, now: number): { from: string; to: string } | undefined {
  const suppliedTo = value.to === undefined ? undefined : timestamp(value.to);
  const suppliedFrom = value.from === undefined ? undefined : timestamp(value.from);
  if (value.to !== undefined && !suppliedTo || value.from !== undefined && !suppliedFrom) return undefined;
  const to = suppliedTo ?? new Date(now).toISOString();
  const from = suppliedFrom ?? new Date(Date.parse(to) - SALES_PERFORMANCE_LIMITS.defaultWindowDays * MILLISECONDS_PER_DAY).toISOString();
  const span = Date.parse(to) - Date.parse(from);
  if (span <= 0 || span > SALES_PERFORMANCE_LIMITS.maximumWindowDays * MILLISECONDS_PER_DAY) return undefined;
  return { from, to };
}

function performanceQuery(value: unknown, now: number): SalesPerformanceQuery | undefined {
  if (!record(value) || !keys(value, ['from', 'to', 'groupBy', 'teamId', 'memberUserId', 'source', 'batchId', 'country', 'limit', 'offset'])) return undefined;
  const range = window(value, now), paging = page(value);
  const groupBy = value.groupBy ?? 'lead';
  if (!range || !paging || !SALES_PERFORMANCE_STRATA.includes(groupBy as never)) return undefined;
  if (value.teamId !== undefined && !uuid(value.teamId) || value.memberUserId !== undefined && !uuid(value.memberUserId) || value.batchId !== undefined && !uuid(value.batchId)) return undefined;
  if (!optionalText(value.source, SALES_PERFORMANCE_LIMITS.text) || !optionalText(value.country, SALES_PERFORMANCE_LIMITS.text)) return undefined;
  return {
    ...range,
    groupBy: groupBy as SalesPerformanceQuery['groupBy'],
    ...(value.teamId ? { teamId: value.teamId } : {}),
    ...(value.memberUserId ? { memberUserId: value.memberUserId } : {}),
    ...(value.source ? { source: value.source.trim() } : {}),
    ...(value.batchId ? { batchId: value.batchId } : {}),
    ...(value.country ? { country: value.country.trim() } : {}),
    ...paging,
  };
}

function gradeQuery(value: unknown, now: number): CustomerGradeQuery | undefined {
  if (!record(value) || !keys(value, ['from', 'to', 'customerId', 'teamId', 'memberUserId', 'limit', 'offset'])) return undefined;
  const range = window(value, now), paging = page(value);
  if (!range || !paging) return undefined;
  if (value.customerId !== undefined && !uuid(value.customerId) || value.teamId !== undefined && !uuid(value.teamId) || value.memberUserId !== undefined && !uuid(value.memberUserId)) return undefined;
  return {
    ...range,
    ...(value.customerId ? { customerId: value.customerId } : {}),
    ...(value.teamId ? { teamId: value.teamId } : {}),
    ...(value.memberUserId ? { memberUserId: value.memberUserId } : {}),
    ...paging,
  };
}

function setBody(value: unknown): { expectedVersion: number; grade: string; reason: string; idempotencyKey: string } | undefined {
  if (!record(value) || !keys(value, ['expectedVersion', 'grade', 'reason', 'idempotencyKey'])) return undefined;
  if (!Number.isSafeInteger(value.expectedVersion) || Number(value.expectedVersion) < 0) return undefined;
  if (!CUSTOMER_GRADES.includes(value.grade as never) || !text(value.reason, SALES_PERFORMANCE_LIMITS.reason) || !text(value.idempotencyKey, SALES_PERFORMANCE_LIMITS.key)) return undefined;
  return { expectedVersion: Number(value.expectedVersion), grade: value.grade as string, reason: value.reason.trim(), idempotencyKey: value.idempotencyKey };
}

function clearBody(value: unknown): { expectedVersion: number; reason: string; idempotencyKey: string } | undefined {
  if (!record(value) || !keys(value, ['expectedVersion', 'reason', 'idempotencyKey'])) return undefined;
  if (!Number.isSafeInteger(value.expectedVersion) || Number(value.expectedVersion) < 1) return undefined;
  if (!text(value.reason, SALES_PERFORMANCE_LIMITS.reason) || !text(value.idempotencyKey, SALES_PERFORMANCE_LIMITS.key)) return undefined;
  return { expectedVersion: Number(value.expectedVersion), reason: value.reason.trim(), idempotencyKey: value.idempotencyKey };
}

export function createSalesPerformanceService(repo: SalesPerformanceRepository, tokens: TokenPort, clock: { now(): number }) {
  const run = <T>(token: string, action: (hash: string) => Promise<Result<T>>): Promise<Result<T>> =>
    TOKEN.test(token) ? action(tokens.hash(token)) : Promise.resolve(failure('UNAUTHORIZED', '会话无效') as Result<T>);
  return {
    performance(token: string, value: unknown) {
      const parsed = performanceQuery(value, clock.now());
      return parsed ? run(token, hash => repo.performance(hash, parsed)) : Promise.resolve(failure('INVALID_INPUT', '销售绩效查询参数无效'));
    },
    customerGrades(token: string, value: unknown) {
      const parsed = gradeQuery(value, clock.now());
      return parsed ? run(token, hash => repo.customerGrades(hash, parsed)) : Promise.resolve(failure('INVALID_INPUT', '客户分级查询参数无效'));
    },
    setCustomerGradeOverride(token: string, customerId: string, value: unknown) {
      const parsed = setBody(value);
      if (!UUID.test(customerId) || !parsed) return Promise.resolve(failure('INVALID_INPUT', '客户等级覆盖参数无效'));
      return run(token, hash => repo.setCustomerGradeOverride(hash, { customerId, ...parsed, grade: parsed.grade as import('../core/sales-performance').CustomerGrade }));
    },
    clearCustomerGradeOverride(token: string, customerId: string, value: unknown) {
      const parsed = clearBody(value);
      if (!UUID.test(customerId) || !parsed) return Promise.resolve(failure('INVALID_INPUT', '客户等级清除参数无效'));
      return run(token, hash => repo.clearCustomerGradeOverride(hash, { customerId, ...parsed }));
    },
  };
}

export type SalesPerformanceService = ReturnType<typeof createSalesPerformanceService>;
