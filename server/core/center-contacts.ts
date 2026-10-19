import type {ContactPermissions} from './contact-sharing';
import { CRM_STAGES, failure, success, type JsonObject, type Result } from './crm';
import type { ContactTouchStatus, CustomerStage, LeadState } from './leads';

export const CENTER_CONTACT_ROUTE = '/api/crm/contacts';
export const CENTER_CONTACT_LIMITS = { page: 50, pageMax: 100, text: 500 } as const;
export const CENTER_CONTACT_FILTERS = ['stage', 'status', 'tags', 'clientType', 'country', 'language'] as const;
export interface CenterContactQuery {
  search: string; limit: number; offset: number;
  /** Sending sequence, never the customer's relationship stage. */
  stage?: string; status?: string; tags?: string; clientType?: string; country?: string; language?: string;
  touchStatus?: ContactTouchStatus;
  scope?: 'all' | 'personal' | 'assigned'; assignment?: 'accepted';
  followupOnly?: boolean; crmStage?: CustomerStage;
}
export interface CenterContact {
  /** Center IDs are explicit and never masquerade as legacy SQLite `id`. */
  contactId: number; customerId: string; customerVersion: number;
  permissions?: ContactPermissions; isShared?: boolean; canSendMail?: boolean; contactVersion?: number; canDelete?: boolean; canEdit?: boolean; canAssign?: boolean; canFollowup?: boolean;
  relationshipStage?: CustomerStage;
  /** Latest real contact activity by occurrence time; notes and opportunity activities are excluded. */
  lastFollowupAt?: string | null; lastFollowupNote?: string | null;
  companyId: number; companyName: string; email: string | null;
  businessType?: string | null; website?: string | null;
  firstName: string | null; lastName: string | null; title: string | null;
  phone: string | null; whatsapp: string | null; linkedinUrl: string | null; country: string | null;
  clientType: string | null; language: string | null;
  stage: string; status: string; tags: string[]; extra: JsonObject;
  touchStatus: ContactTouchStatus; assignee: string;
  source: string; sourceDetail: string | null; sourceLevel1: string | null; sourceLevel2: string | null; createdAt: string; updatedAt: string;
  ownerUserId: string | null; ownerName: string | null;
  origin: 'operations' | 'personal'; state: LeadState;
  /** Current request state; ownership alone does not prove a request was accepted. */
  assignmentStatus?: 'pending' | 'accepted' | null;
}
export interface CenterContactPage { items: CenterContact[]; total: number; }

/** Same canonical query is used at HTTP, IPC and renderer boundaries. */
export function centerContactQuery(value: unknown): Result<CenterContactQuery> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return failure('INVALID_INPUT', '联系人查询参数无效');
  const input = value as Record<string, unknown>;
  const allowed: readonly string[] = ['search', 'limit', 'offset', ...CENTER_CONTACT_FILTERS, 'scope', 'assignment', 'followupOnly', 'crmStage', 'touchStatus'];
  if (Object.keys(input).some(key => !allowed.includes(key))) return failure('INVALID_INPUT', '联系人查询含未知参数');
  const search = input.search ?? '';
  const limit = input.limit ?? CENTER_CONTACT_LIMITS.page;
  const offset = input.offset ?? 0;
  if (typeof search !== 'string' || search.length > CENTER_CONTACT_LIMITS.text || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > CENTER_CONTACT_LIMITS.pageMax || !Number.isSafeInteger(offset) || Number(offset) < 0) return failure('INVALID_INPUT', '联系人分页或搜索参数无效');
  const query: CenterContactQuery = { search: search.trim(), limit: Number(limit), offset: Number(offset) };
  if (input.scope !== undefined) {
    if (!['all', 'personal', 'assigned'].includes(input.scope as string)) return failure('INVALID_INPUT', '联系人来源无效');
    query.scope = input.scope as CenterContactQuery['scope'];
  }
  if (input.assignment !== undefined) {
    if (input.assignment !== 'accepted') return failure('INVALID_INPUT', '分配状态无效');
    query.assignment = 'accepted';
  }
  if (input.followupOnly !== undefined) {
    if (typeof input.followupOnly !== 'boolean') return failure('INVALID_INPUT', '跟进筛选无效');
    query.followupOnly = input.followupOnly;
  }
  if (input.crmStage !== undefined) {
    if (!['cold', ...CRM_STAGES].includes(input.crmStage as string)) return failure('INVALID_INPUT', '客户关系阶段无效');
    query.crmStage = input.crmStage as CustomerStage;
  }
  if (input.touchStatus !== undefined) {
    if (!['uncontacted', 'contacted', 'replied', 'unreachable'].includes(input.touchStatus as string)) return failure('INVALID_INPUT', '联系人联系状态无效');
    query.touchStatus = input.touchStatus as ContactTouchStatus;
  }
  for (const key of CENTER_CONTACT_FILTERS) {
    const item = input[key];
    if (item === undefined) continue;
    if (typeof item !== 'string' || item.length > CENTER_CONTACT_LIMITS.text) return failure('INVALID_INPUT', '联系人筛选参数无效');
    if (item.trim()) query[key] = item.trim();
  }
  return success(query);
}

export function centerContactPath(query: CenterContactQuery): string {
  const fields = [['search', query.search], ['limit', String(query.limit)], ['offset', String(query.offset)]];
  for (const key of CENTER_CONTACT_FILTERS) if (query[key] !== undefined) fields.push([key, query[key]!]);
  for (const key of ['scope', 'assignment', 'followupOnly', 'crmStage', 'touchStatus'] as const) if (query[key] !== undefined) fields.push([key, String(query[key])]);
  return `${CENTER_CONTACT_ROUTE}?${fields.map(([key, value]) => `${key}=${encodeURIComponent(value!)}`).join('&')}`;
}
