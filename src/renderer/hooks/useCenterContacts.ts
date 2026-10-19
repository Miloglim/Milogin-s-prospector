import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { ONLINE_CHANNELS, ONLINE_LIMITS, CENTER_CONTACT_LIMITS, CENTER_CONTACT_FILTERS, centerContactQuery, type Result, type CenterContact, type CenterContactPage, type CenterContactQuery } from '../../shared/online-crm';
import { useIdentity } from '../IdentityContext';

export interface CenterContactRow extends Omit<CenterContact, 'email' | 'tags' | 'extra'> {
  /** Stable renderer key; the legacy `id` field is intentionally absent. */
  rowKey: string;
  /** Legacy display fields are normalized only at this boundary. */
  firstName: string | null;
  lastName: string | null;
  email: string;
  tags: string;
  extra: string;
  assignee: string;
}
export interface CenterContactListData { items: CenterContactRow[]; total: number; }
export type CenterContactInvoke = (channel: string, input: CenterContactQuery) => Promise<Result<CenterContactPage>>;

function row(value: CenterContact): CenterContactRow | undefined {
  if (!value || !Number.isSafeInteger(value.contactId) || value.contactId < 1 || typeof value.customerId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.customerId) || !Number.isSafeInteger(value.customerVersion) || value.customerVersion < 1 || typeof value.companyName !== 'string' || typeof value.updatedAt !== 'string' || !Array.isArray(value.tags) || value.tags.some(tag => typeof tag !== 'string') || !value.extra || typeof value.extra !== 'object' || Array.isArray(value.extra)) return undefined;
  return {
    ...value,
    rowKey: `${value.customerId}:${value.contactId}`,
    email: value.email ?? '',
    tags: JSON.stringify(value.tags ?? []),
    extra: JSON.stringify(value.extra ?? {}),
    assignee: value.ownerName ?? '',
  };
}

export async function readCenterContacts(input: { search?: string; page?: number; pageSize?: number } & Partial<Record<typeof CENTER_CONTACT_FILTERS[number], string>>, invoke: CenterContactInvoke): Promise<Result<CenterContactListData>> {
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? CENTER_CONTACT_LIMITS.page;
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > CENTER_CONTACT_LIMITS.pageMax) return { ok: false, error: { code: 'INVALID_INPUT', message: '联系人分页参数无效' } };
  const query = centerContactQuery({ search: input.search ?? '', limit: pageSize, offset: (page - 1) * pageSize, ...Object.fromEntries(CENTER_CONTACT_FILTERS.filter(key => input[key] !== undefined).map(key => [key, input[key]])) });
  if (!query.ok) return query;
  try {
    const result = await invoke(ONLINE_CHANNELS.CONTACT_LIST, query.data);
    if (!result || typeof result.ok !== 'boolean') return { ok: false, error: { code: 'UNAVAILABLE', message: '中心联系人返回格式错误' } };
    if (!result.ok) return result;
    if (!result.data || !Array.isArray(result.data.items) || result.data.items.length > query.data.limit || !Number.isSafeInteger(result.data.total) || result.data.total < result.data.items.length) return { ok: false, error: { code: 'UNAVAILABLE', message: '中心联系人返回格式错误' } };
    const items = result.data.items.map(row);
    if (items.some(value => value === undefined) || new Set(items.map(value => value?.rowKey)).size !== items.length) return { ok: false, error: { code: 'UNAVAILABLE', message: '中心联系人返回格式错误' } };
    return { ok: true, data: { items: items as CenterContactRow[], total: result.data.total } };
  } catch {
    // IPC rejections become a visible query error; never turn them into an empty successful list.
    return { ok: false, error: { code: 'UNAVAILABLE', message: '中心联系人查询失败' } };
  }
}

export function useCenterContacts(input: { search?: string; page?: number; pageSize?: number } & Partial<Record<typeof CENTER_CONTACT_FILTERS[number], string>>, invoke: CenterContactInvoke = (channel, query) => window.api.invoke(channel, query) as Promise<Result<CenterContactPage>>) {
  const { identity, baseUrl, status } = useIdentity();
  const permissionScope = JSON.stringify([identity?.crmRoles?.slice().sort(), identity?.crmCapabilities?.slice().sort(), identity?.identityAdmin, identity?.mustChangePassword]);
  const normalized = { search: input.search ?? '', page: input.page ?? 1, pageSize: input.pageSize ?? CENTER_CONTACT_LIMITS.page, ...Object.fromEntries(CENTER_CONTACT_FILTERS.filter(key => input[key] !== undefined).map(key => [key, input[key]])) };
  return useQuery({ queryKey: ['center-contacts', baseUrl, identity?.userId, normalized, permissionScope], queryFn: () => readCenterContacts(normalized, invoke), enabled: !!identity && ['authenticated', 'offline'].includes(status), refetchInterval: ONLINE_LIMITS.pollMs, placeholderData: (previous, previousQuery) => previousQuery?.queryKey[1] === baseUrl && previousQuery.queryKey[2] === identity?.userId && previousQuery.queryKey[4] === permissionScope ? keepPreviousData(previous) : undefined });
}
