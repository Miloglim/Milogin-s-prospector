import { failure, type Result } from '../core/crm';
import type { TokenPort } from '../core/auth';
import {
  CUSTOMER_STATUSES,
  CUSTOMER_STATUS_LIMITS,
  type CustomerStatusCorrection,
  type CustomerStatusResume,
  type CustomerStatusState,
  type CustomerStatusView,
} from '../core/customer-status';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export interface CustomerStatusRepository {
  view(hash: string, customerId: string): Promise<Result<CustomerStatusView>>;
  correct(hash: string, input: CustomerStatusCorrection): Promise<Result<CustomerStatusState>>;
  resumeAi(hash: string, input: CustomerStatusResume): Promise<Result<CustomerStatusState>>;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function key(value: unknown): value is string {
  return text(value, CUSTOMER_STATUS_LIMITS.key);
}

export function createCustomerStatusService(repo: CustomerStatusRepository, tokens: TokenPort) {
  const run = <T>(token: string, action: (hash: string) => Promise<Result<T>>) => /^[A-Za-z0-9_-]{43}$/.test(token) ? action(tokens.hash(token)) : Promise.resolve(failure('UNAUTHORIZED', '会话无效'));
  return {
    view(token: string, customerId: string) {
      return UUID.test(customerId) ? run(token, hash => repo.view(hash, customerId)) : Promise.resolve(failure('NOT_FOUND', '客户不存在'));
    },
    correct(token: string, input: unknown) {
      if (!record(input) || !UUID.test(String(input.customerId ?? '')) || !Number.isSafeInteger(input.expectedVersion) || Number(input.expectedVersion) < 0
        || !CUSTOMER_STATUSES.includes(input.status as never) || !text(input.reason, CUSTOMER_STATUS_LIMITS.reason) || !key(input.idempotencyKey)
        || input.contactId !== undefined && (!Number.isSafeInteger(input.contactId) || Number(input.contactId) < 1)) return Promise.resolve(failure('INVALID_INPUT', '客户状态纠正参数无效'));
      return run(token, hash => repo.correct(hash, input as unknown as CustomerStatusCorrection));
    },
    resumeAi(token: string, input: unknown) {
      if (!record(input) || !UUID.test(String(input.customerId ?? '')) || !Number.isSafeInteger(input.expectedVersion) || Number(input.expectedVersion) < 1 || !key(input.idempotencyKey)) return Promise.resolve(failure('INVALID_INPUT', '恢复 AI 维护参数无效'));
      return run(token, hash => repo.resumeAi(hash, input as unknown as CustomerStatusResume));
    },
  };
}

export type CustomerStatusService = ReturnType<typeof createCustomerStatusService>;
