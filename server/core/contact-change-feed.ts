import type { CenterContact } from './center-contacts';
import { failure, success, type Result } from './crm';

export const CONTACT_CHANGE_ROUTE = '/api/crm/contact-changes';
export const CONTACT_CHANGE_LIMITS = { page: 50, pageMax: 100, cursorDigits: 19 } as const;
export type ContactChangeKind = 'upsert' | 'tombstone';
export interface ContactChange { cursor: string; eventId: string; eventType: string; contactId: number; customerId: string; version: number; kind: ContactChangeKind; contact?: CenterContact; }
export interface ContactChangeQuery { after: string; limit: number; }
export interface ContactChangePage { items: ContactChange[]; nextCursor: string; hasMore: boolean; resyncRequired?: boolean; /** Global committed high-water mark, used to establish a full-scan baseline. */ headCursor?: string; }
export interface ContactChangeRepository { feed(hash: string, query: ContactChangeQuery): Promise<Result<ContactChangePage>>; }
export function contactChangeQuery(value: unknown): Result<ContactChangeQuery> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return failure('INVALID_INPUT', '联系人变化参数无效');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(k => !['after', 'limit'].includes(k))) return failure('INVALID_INPUT', '联系人变化参数无效');
  const after = input.after ?? '0', limitValue = input.limit ?? CONTACT_CHANGE_LIMITS.page;
  const limit = typeof limitValue === 'number' ? limitValue : Number.NaN;
  const cursor = new RegExp(`^(0|[1-9][0-9]{0,${CONTACT_CHANGE_LIMITS.cursorDigits - 1}})$`);
  if (typeof after !== 'string' || !cursor.test(after) || BigInt(after) > 9223372036854775807n || !Number.isSafeInteger(limit) || limit < 1 || limit > CONTACT_CHANGE_LIMITS.pageMax) return failure('INVALID_INPUT', '联系人变化游标无效');
  return success({ after, limit });
}
