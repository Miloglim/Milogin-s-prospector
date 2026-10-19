import { failure, success, type JsonObject, type Result } from './crm';
import { LEAD_LIMITS } from './leads';

/** Workbook contracts: source references identify approved source mappings, never account permissions. */
export const WORKBOOK_IMPORT_ROUTE = '/api/crm/workbook-imports';
export const WORKBOOK_LIMITS = { sheets: 20, columns: 100, entityRows: 10000, totalRows: 20000, reference: 500, batchRows: 200, bodyBytes: 1048576 } as const;
export interface ImportSheetPreview {
  sheetName: string; headers: string[]; rows: Record<string, string>[]; rowNumbers: number[];
  error?: string;
}
export interface WorkbookImportRow {
  entity: 'customer' | 'contact'; sourceRef: string; customerRef?: string;
  companyName?: string; country?: string; customerType?: string; businessType?: string; developmentRestriction?: string;
  sourceCreatedAt?: string; email?: string; name?: string; phone?: string; whatsapp?: string; title?: string; sourceLevel1?: string; sourceLevel2?: string;
  firstName?: string; lastName?: string; linkedinUrl?: string; language?: string; clientType?: string;
  stage?: string; status?: string; tags?: string[];
  sheetName: string; rowNumber: number; rawRow: JsonObject;
}
export interface WorkbookImportRequest {
  source: string; sourceDetail: string; idempotencyKey: string; kind: 'operations' | 'personal';
  rows: WorkbookImportRow[];
}
export type WorkbookRowStatus = 'created' | 'appended' | 'duplicate' | 'invalid' | 'unmatched' | 'ambiguous' | 'restricted_conflict';
export interface WorkbookReceiptRow {
  rowId: string; index: number; entity: 'customer' | 'contact'; sheetName: string; rowNumber: number;
  status: WorkbookRowStatus; customerId?: string; message?: string;
}
export interface WorkbookImportReceipt { batchId: string; rows: WorkbookReceiptRow[]; }
export interface WorkbookMapping {
  customer: Record<string, string>; contact: Record<string, string>;
}
export interface WorkbookPlanRow {
  key: string; input: WorkbookImportRow; issue?: string; candidates: Array<{ ref: string; label: string }>;
}
export interface WorkbookImportPlan { customers: WorkbookPlanRow[]; contacts: WorkbookPlanRow[]; }

const normalized = (value: string): string => value.trim().replace(/\s+/g, ' ').toLowerCase();
const FIELD_LIMIT = 4096;
const EMAIL_LIMIT = 254;
const CLOCK_HOUR_MAX = 23;
const CLOCK_MINUTE_SECOND_MAX = 59;
/** Date-only and zoneless source times use UTC, independent of the desktop or center time zone. */
export function normalizeSourceDate(value: string): string | undefined {
  const match = /^(?:(\d{4})-(\d{2})-(\d{2})|(\d{4})\/(\d{1,2})\/(\d{1,2}))(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(value);
  if (!match) return undefined;
  const year = Number(match[1] ?? match[4]); const month = Number(match[2] ?? match[5]); const day = Number(match[3] ?? match[6]);
  if (!year) return undefined;
  const calendar = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const date = new Date(`${calendar}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return undefined;
  if (!match[7]) return date.toISOString();
  if (Number(match[7]) > CLOCK_HOUR_MAX || Number(match[8]) > CLOCK_MINUTE_SECOND_MAX || Number(match[9] ?? 0) > CLOCK_MINUTE_SECOND_MAX) return undefined;
  const zone = match[11] ?? 'Z';
  if (zone !== 'Z' && (Number(zone.slice(1, 3)) > CLOCK_HOUR_MAX || Number(zone.slice(4)) > CLOCK_MINUTE_SECOND_MAX)) return undefined;
  const time = `${match[7]}:${match[8]}:${match[9] ?? '00'}${match[10] ? `.${match[10]}` : ''}${zone}`;
  const timestamp = Date.parse(`${calendar}T${time}`);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}
const synonyms: Record<string, string[]> = {
  sourceRef: ['sourceRef', 'id', '源ID', '客户ID', '客户编号', '联系人ID', '联系人编号'],
  companyName: ['companyName', 'company', '公司', '公司名称', '客户名称', '客户抬头'],
  customerRef: ['customerRef', '客户ID', '客户编号', '公司', '公司名称', '客户名称', '客户抬头'],
  country: ['country', '国家', '所在国家'], customerType: ['customerType', '客户类型', '客户类别'], businessType: ['businessType', '业务类型', '品类', '行业'],
  developmentRestriction: ['developmentRestriction', '开发限制', '跟进限制'],
  sourceCreatedAt: ['sourceCreatedAt', '创建时间', '建立时间'], name: ['name', '姓名', '联系人', '联系人姓名'],
  email: ['email', '邮箱', '电子邮箱', '邮件地址', 'e-mail'], phone: ['phone', '电话', '手机', '联系电话'], whatsapp: ['whatsapp', 'WhatsApp', 'Whats App', 'WA'], sourceLevel1: ['sourceLevel1', '一级来源', '来源一级'], sourceLevel2: ['sourceLevel2', '二级来源', '来源二级'],
  title: ['title', '职务', '职位'],
  firstName: ['firstName', 'first_name', '名'], lastName: ['lastName', 'last_name', '姓'],
  linkedinUrl: ['linkedinUrl', 'linkedin', '领英'], language: ['language', '语言'],
  clientType: ['clientType', 'client_type', '联系人类型'], stage: ['stage', '发送阶段'],
  status: ['status', '状态'], tags: ['tags', '标签'],
};
/** Suggested column mapping only; the administrator can override every field. */
export function autoWorkbookMapping(headers: string[], entity: 'customer' | 'contact'): Record<string, string> {
  const fields = entity === 'customer'
    ? ['sourceRef', 'companyName', 'country', 'customerType', 'businessType', 'developmentRestriction', 'sourceCreatedAt']
    : ['sourceRef', 'customerRef', 'name', 'firstName', 'lastName', 'email', 'phone', 'whatsapp', 'title', 'country', 'linkedinUrl', 'language', 'clientType', 'sourceLevel1', 'sourceLevel2', 'stage', 'status', 'tags'];
  return Object.fromEntries(fields.flatMap(field => {
    const aliases = field === 'sourceRef' ? (entity === 'customer'
      ? ['sourceRef', 'id', '源ID', '客户ID', '客户编号']
      : ['sourceRef', 'id', '源ID', '联系人ID', '联系人编号']) : synonyms[field]!;
    const header = aliases.map(alias => headers.find(value => normalized(value) === normalized(alias))).find(Boolean);
    return header ? [[field, header]] : [];
  }));
}
/** Source aliases are provisional references scoped by creator and source at the center. */
export function workbookRowIssue(row: WorkbookImportRow): string | undefined {
  if (!row || !['customer', 'contact'].includes(row.entity)) return '记录类型无效';
  if (!row.sourceRef?.trim() || row.sourceRef.length > WORKBOOK_LIMITS.reference) return '来源引用缺失或过长';
  if (!row.sheetName?.trim() || !Number.isSafeInteger(row.rowNumber) || row.rowNumber < 1) return '来源行定位无效';
  if (row.entity === 'customer' && !row.companyName?.trim()) return '客户抬头为空';
  if (row.entity === 'customer' && row.customerType && !['代理','直客'].includes(row.customerType.trim())) return '客户类型只能填写代理或直客';
  if (row.entity === 'contact' && !row.customerRef?.trim()) return '联系人缺少客户关联';
  if (row.customerRef && row.customerRef.length > WORKBOOK_LIMITS.reference) return '客户关联引用过长';
  if (row.entity === 'contact' && ![row.email, row.name, row.firstName, row.lastName, row.phone, row.whatsapp].some(value => value?.trim())) return '联系人姓名、电话或邮箱至少填写一项';
  if (row.email && (row.email.length > EMAIL_LIMIT || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email))) return '联系人邮箱格式无效或超过254字符';
  if ([row.companyName,row.country,row.customerType,row.businessType,row.developmentRestriction,row.name,row.phone,row.whatsapp,row.title,row.firstName,row.lastName,row.linkedinUrl,row.language,row.clientType,row.sourceLevel1,row.sourceLevel2,row.stage,row.status].some(value => value !== undefined && value.length > LEAD_LIMITS.text)) return '客户或联系人字段内容过长';
  if (row.tags !== undefined && (!Array.isArray(row.tags) || row.tags.length > LEAD_LIMITS.pageMax || row.tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > LEAD_LIMITS.text))) return '联系人标签无效';
  if (row.sourceCreatedAt && !normalizeSourceDate(row.sourceCreatedAt)) return '源创建时间无效，请使用YYYY-MM-DD或YYYY/M/D及有效时间';
  if (Object.values(row).some(value => typeof value === 'string' && value.length > FIELD_LIMIT)) return '字段内容过长';
  return undefined;
}
export function buildWorkbookPlan(customerSheet: ImportSheetPreview | undefined, contactSheet: ImportSheetPreview | undefined, mapping: WorkbookMapping): WorkbookImportPlan {
  const build = (sheet: ImportSheetPreview | undefined, entity: 'customer' | 'contact'): WorkbookPlanRow[] => (sheet?.rows ?? []).map((rawRow, index) => {
    const input: WorkbookImportRow = { entity, sourceRef: '', sheetName: sheet!.sheetName, rowNumber: sheet!.rowNumbers[index] ?? index + 2, rawRow: { ...rawRow } };
    const columns = mapping[entity];
    for (const field of Object.keys(synonyms)) {
      const value = rawRow[columns[field] ?? '']?.trim();
      if (value) (input as unknown as Record<string, unknown>)[field] = field === 'tags' ? value.split(/[;,，；、|]+/).map(tag => tag.trim()).filter(Boolean) : value;
    }
    if (entity === 'contact' && input.email) input.email = normalized(input.email);
    if (!input.sourceRef) input.sourceRef = entity === 'customer' ? `name:${normalized(input.companyName ?? '')}`
      : input.email ? `email:${input.email}` : `contact:${JSON.stringify([normalized(input.customerRef ?? ''), normalized(input.name ?? ''), normalized(input.phone ?? '')])}`;
    let categoryIssue: string | undefined;
    if (entity === 'customer' && input.businessType) {
      const parts = input.businessType.split(/[;,，；、|/]+/).map(part => part.trim()).filter(Boolean);
      const restriction = parts.filter(part => /不跟进|禁止开发|勿联系|不开发/.test(part));
      const relationship = parts.filter(part => /已合作|已成交/.test(part));
      input.businessType = parts.filter(part => !restriction.includes(part) && !relationship.includes(part)).join('、') || undefined;
      if (restriction.length) input.developmentRestriction = [input.developmentRestriction, ...restriction].filter(Boolean).join('、');
      if (relationship.length) categoryIssue = `客户类别含${relationship.join('、')}，关系状态待确认`;
    }
    if (entity === 'customer' && input.customerType) {
      const parts = input.customerType.split(/[;,，；、|/]+/).map(part => part.trim()).filter(Boolean);
      const type = parts.find(part => ['代理', '直客'].includes(part));
      const restriction = parts.filter(part => /不跟进|禁止开发|勿联系|不开发/.test(part));
      input.customerType = type ?? input.customerType;
      if (parts.filter(part=>['代理','直客'].includes(part)).length>1) categoryIssue='客户类型同时包含代理和直客，请核对';
      if (restriction.length) input.developmentRestriction = [input.developmentRestriction, ...restriction].filter(Boolean).join('、');
      if (parts.some(part => /已合作|已成交/.test(part))) categoryIssue = `客户类别含${parts.filter(part => /已合作|已成交/.test(part)).join('、')}，关系状态待确认`;
    }
    return { key: `${entity}:${sheet!.sheetName}:${input.rowNumber}`, input, issue: sheet!.error ?? workbookRowIssue(input) ?? categoryIssue, candidates: [] };
  });
  const customers = build(customerSheet, 'customer'); const contacts = build(contactSheet, 'contact');
  const byRef = new Map<string, WorkbookPlanRow[]>(); const byName = new Map<string, WorkbookPlanRow[]>();
  for (const row of customers) {
    const ref = normalized(row.input.sourceRef); byRef.set(ref, [...(byRef.get(ref) ?? []), row]);
    const name = normalized(row.input.companyName ?? ''); if (name) byName.set(name, [...(byName.get(name) ?? []), row]);
  }
  for (const rows of byRef.values()) if (rows.length > 1) for (const row of rows) {
    row.issue = '客户来源引用重复，请确认不同客户的来源ID';
    row.candidates = rows.map(candidate => ({ ref: candidate.input.sourceRef, label: `${candidate.input.companyName ?? ''} (${candidate.input.rowNumber})` }));
  }
  for (const row of contacts) {
    const ref = normalized(row.input.customerRef ?? '');
    const candidates = byRef.get(ref) ?? byName.get(ref) ?? [];
    row.candidates = candidates.map(candidate => ({ ref: candidate.input.sourceRef, label: `${candidate.input.companyName ?? ''} (${candidate.input.rowNumber})` }));
    if (!candidates.length) row.issue = row.issue ?? '未匹配客户，请确认客户关联';
    else if (candidates.length > 1 || (byRef.get(normalized(candidates[0]!.input.sourceRef))?.length ?? 0) > 1) row.issue = '客户关联存在歧义，请明确选择';
    else row.input.customerRef = candidates[0]!.input.sourceRef;
  }
  const contactRefs = new Map<string, WorkbookPlanRow[]>();
  for (const row of contacts) { const ref = normalized(row.input.sourceRef); contactRefs.set(ref, [...(contactRefs.get(ref) ?? []), row]); }
  for (const rows of contactRefs.values()) if (rows.length > 1) for (const row of rows) {
    row.issue = row.issue ?? '联系人来源引用重复，请确认重复或跨客户关联';
    row.candidates = rows.map(candidate => ({ ref: candidate.input.sourceRef, label: `${candidate.input.name ?? candidate.input.email ?? candidate.input.phone ?? ''} (${candidate.input.customerRef ?? ''}, ${candidate.input.rowNumber})` }));
  }
  return { customers, contacts };
}
function utf8Bytes(value: string): number {
  let size = 0;
  for (const character of value) { const code = character.codePointAt(0)!; size += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4; }
  return size;
}
/** Customer batches precede contact batches; keys stay deterministic across unknown-response retries. */
export function prepareWorkbookRequests(base: Omit<WorkbookImportRequest, 'rows'>, rows: WorkbookImportRow[]): Result<WorkbookImportRequest[]> {
  if (!base.source?.trim() || !base.idempotencyKey?.trim() || !['operations', 'personal'].includes(base.kind)) return failure('INVALID_INPUT', '导入来源或批次标识无效');
  if (base.source.length > LEAD_LIMITS.text || typeof base.sourceDetail !== 'string' || base.sourceDetail.length > LEAD_LIMITS.text || base.idempotencyKey.length > LEAD_LIMITS.key) return failure('INVALID_INPUT', '导入来源、说明或批次标识过长');
  if (rows.length > WORKBOOK_LIMITS.totalRows || ['customer', 'contact'].some(entity => rows.filter(row => row.entity === entity).length > WORKBOOK_LIMITS.entityRows)) return failure('PAYLOAD_TOO_LARGE', '选定客户或联系人数据超过导入行数限制');
  const issue = rows.map(workbookRowIssue).find(Boolean); if (issue) return failure('INVALID_INPUT', issue);
  const references = new Set<string>();
  for (const row of rows) {
    const ref = `${row.entity}:${normalized(row.sourceRef)}`;
    if (references.has(ref)) return failure('INVALID_INPUT', `来源行 ${row.rowNumber} 的来源引用重复，请确认后重试`);
    references.add(ref);
  }
  const requests: WorkbookImportRequest[] = [];
  for (const entity of ['customer', 'contact'] as const) {
    let current: WorkbookImportRequest | undefined;
    for (const row of rows.filter(item => item.entity === entity)) {
      if (!current) current = { ...base, idempotencyKey: `${base.idempotencyKey}:${requests.length + 1}`, rows: [] };
      const candidate = { ...current, rows: [...current.rows, row] };
      if (current.rows.length && (candidate.rows.length > WORKBOOK_LIMITS.batchRows || utf8Bytes(JSON.stringify(candidate)) > WORKBOOK_LIMITS.bodyBytes)) {
        requests.push(current); current = { ...base, idempotencyKey: `${base.idempotencyKey}:${requests.length + 1}`, rows: [] };
      }
      current.rows.push(row);
      if (utf8Bytes(JSON.stringify(current)) > WORKBOOK_LIMITS.bodyBytes) return failure('PAYLOAD_TOO_LARGE', `来源行 ${row.rowNumber} 超过单批大小限制`);
    }
    if (current) requests.push(current);
  }
  if (requests.some(request => request.idempotencyKey.length > LEAD_LIMITS.key)) return failure('INVALID_INPUT', '批次标识添加分批编号后过长，请使用更短的标识');
  return success(requests);
}
