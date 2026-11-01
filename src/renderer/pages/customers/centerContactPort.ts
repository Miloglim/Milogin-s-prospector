import {LEAD_IMPORT_FIELDS, leadImportMapping} from '../../../../server/core/lead-import-fields';
import { importRowIssue } from '../../../../server/core/leads';
import { ONLINE_CHANNELS, CENTER_CONTACT_LIMITS, centerContactDisplayStatus, centerContactRemark, type CenterContact, type CenterContactQuery, type CenterContactPage, type CenterContactDetail, type ContactDelete, type ContactDeleteReceipt, type Result, type ImportPreview, type ImportReceipt, type ImportRequest } from '../../../shared/online-crm';
import type { Contact, ContactDataPort, ContactFilters } from '../../hooks/useContacts';
import type { ImportDrawerPort, ImportExecutionResult } from '../../components/ImportDrawer';
import { importFingerprint, prepareImportRequests } from './customerImport';
import type { LeadIngressConflictNotice } from './LeadIngressConflictDrawer';

export type CenterInvoke = <T>(channel: string, input?: unknown) => Promise<Result<T>>;
const IMPORT_ROW_OFFSET = 2;
const HEX_RADIX = 16;
const HEX_WIDTH = 2;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SERVER_IMPORT_KEY_LENGTH = 120;
export const centerInvoke: CenterInvoke = (channel, input) => window.api.invoke(channel, input) as never;
async function companyImportKey(companyName: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(companyName.trim().toLowerCase()));
  return Array.from(new Uint8Array(digest), byte => byte.toString(HEX_RADIX).padStart(HEX_WIDTH, '0')).join('');
}
export function displayCenterContact(row: CenterContact): Contact {
  return {
    ...row,
    id: row.contactId,
    dataSource: 'center',
    contactVersion: row.contactVersion ?? row.customerVersion,
    email: row.email ?? '',
    status: centerContactDisplayStatus(row),
    relationshipStage: row.relationshipStage ?? null,
    tags: JSON.stringify(row.tags),
    extra: JSON.stringify(row.extra),
    assignee: row.ownerName ?? '',
  };
}

export interface CenterContactPort extends ContactDataPort {
  records: Map<number, CenterContact>;
  scope?:CenterContactQuery['scope'];
  isCurrent():boolean;
  readAll(filters?: { search?: string; followupOnly?: boolean } & ContactFilters): Promise<{ success: boolean; data?: CenterContact[]; error?: string }>;
}
export function createCenterContactPort({ key, invoke = centerInvoke, scope = 'all', assignment, group, isCurrent = () => true }: { key: string; invoke?: CenterInvoke; scope?: CenterContactQuery['scope']; assignment?: 'accepted'; group?: Pick<CenterContactQuery,'groupDimension'|'groupKey'>; isCurrent?: () => boolean }): CenterContactPort {
  const records = new Map<number, CenterContact>();
  const deleteRequests = new Map<string,ContactDelete>();
  async function remove(ids:number[]) {
    if(!isCurrent())return {success:false,error:"账号或权限已变化"};
    if(!ids.length||new Set(ids).size!==ids.length)return {success:false,error:"联系人选择已变化，请刷新后重试"};
    const rows=ids.map(id=>records.get(id));
    if(rows.some(row=>!row?.canDelete))return {success:false,error:"所选联系人不可删除"};
    if(rows.some(row=>!row||!UUID_PATTERN.test(row.customerId)||!Number.isSafeInteger(row.contactVersion??row.customerVersion)||(row.contactVersion??row.customerVersion)<1))return {success:false,error:"联系人缺少中心编号或版本，请刷新后重试"};
    const contacts=rows.map(row=>({contactId:row!.contactId,customerId:row!.customerId,expectedVersion:row!.contactVersion??row!.customerVersion}));
    const signature=JSON.stringify(contacts);let request=deleteRequests.get(signature);if(!request){request={contacts,idempotencyKey:crypto.randomUUID()};deleteRequests.set(signature,request);}
    const result=await invoke<ContactDeleteReceipt>(ONLINE_CHANNELS.CONTACT_DELETE,request);
    if(!isCurrent())return {success:false,error:"账号或权限已变化"};
    if(!result.ok){if(result.error.code==="CONFLICT")deleteRequests.delete(signature);return {success:false,error:result.error.message};}
    result.data.deleted.forEach(row=>records.delete(row.contactId));deleteRequests.delete(signature);return {success:true};
  }
  let creation: { signature: string; payload: ImportRequest } | null = null;
  const scans = new Map<string, ReturnType<CenterContactPort['readAll']>>();
  const read = async (params: { search?: string; page?: number; pageSize?: number; followupOnly?: boolean } & ContactFilters = {}) => {
    const pageSize = params.pageSize ?? CENTER_CONTACT_LIMITS.page;
    const { page, pageSize: _pageSize, ...filters } = params;
    const result = await invoke<CenterContactPage>(ONLINE_CHANNELS.CONTACT_LIST, { search: '', ...filters, scope, ...(assignment ? { assignment } : {}), ...(group ?? {}), limit: pageSize, offset: ((page ?? 1) - 1) * pageSize });
    if (!isCurrent()) return { success: false as const, error: '账号或权限已变化' };
    if (!result.ok) return { success: false as const, error: result.error.message };
    result.data.items.forEach(row => records.set(row.contactId, row));
    return { success: true as const, data: result.data };
  };
  const scan: CenterContactPort['readAll'] = async (filters = {}) => {
    const items: CenterContact[] = [];
    const seen = new Set<number>();
    let page = 1;
    while (true) {
      const result = await read({ ...filters, page, pageSize: CENTER_CONTACT_LIMITS.pageMax });
      if (!result.success || !result.data) return { success: false, error: result.error ?? '联系人查询失败' };
      for (const row of result.data.items) {
        if (seen.has(row.contactId)) return { success: false, error: '联系人列表已变化，请刷新重试' };
        seen.add(row.contactId);
        items.push(row);
      }
      if (items.length >= result.data.total) return { success: true, data: items };
      if (!result.data.items.length) return { success: false, error: '联系人列表已变化，请刷新重试' };
      page++;
    }
  };
  const readAll: CenterContactPort['readAll'] = (filters = {}) => {
    const signature = JSON.stringify(filters);
    const existing = scans.get(signature); if (existing) return existing;
    const pending = scan(filters).finally(() => scans.delete(signature));
    scans.set(signature, pending); return pending;
  };
  return {
    key, records, scope, isCurrent, readAll,
    async list(params) { const result = await read(params); return result.data ? { success: true, data: { ...result.data, items: result.data.items.map(displayCenterContact) } } : { success: false, error: result.error }; },
    async listIds(params) { const result = await readAll(params); return result.data ? { success: true, data: { ids: result.data.map(row => row.contactId) } } : { success: false, error: result.error }; },
    async getById(id) { const row = records.get(id); if (!row) return { success: false, error: '请选择中心联系人' }; const result = await invoke<CenterContactDetail>(ONLINE_CHANNELS.CONTACT_DETAIL, { contactId: row.contactId, customerId: row.customerId }); return result.ok ? { success: true, data: displayCenterContact(result.data.contact) } : { success: false, error: result.error.message }; },
    async upsert(input) {
      if (!isCurrent()) return {success:false,error:'账号或权限已变化'};
      if (input.id !== undefined) return { success: false, error: '请在联系人详情中修改资料' };
      const fields = Object.fromEntries(LEAD_IMPORT_FIELDS.map(({key}) => [key, typeof input[key] === 'string' ? input[key].trim() : '']).filter(([,value]) => value));
      const row = { ...fields, companyName: fields.companyName ?? '', email: (fields.email ?? '').toLowerCase(), customerKey: await companyImportKey(fields.companyName ?? ''), name: fields.name || [fields.firstName, fields.lastName].filter(Boolean).join(' ') };
      const issue = importRowIssue(row); if (issue) return { success: false, error: issue };
      const signature = JSON.stringify(row);
      if (creation?.signature !== signature) creation = { signature, payload: { source: 'manual', sourceDetail: '', companyMatching: true, idempotencyKey: crypto.randomUUID(), rows: [row] } };
      const result = await invoke<ImportReceipt>(ONLINE_CHANNELS.IMPORT, creation.payload);
      if (!isCurrent()) return {success:false,error:'账号或权限已变化'};
      if (!result.ok) return { success: false, error: result.error.message };
      const receipt = result.data.rows[0];
      if (receipt?.status !== 'created') {
        const attemptedKey = creation.payload.idempotencyKey;
        creation = null;
        const message = receipt?.status === 'duplicate' ? '联系人已存在，不能重复新建' : receipt?.message ?? '联系人未创建';
        return {
          success: false,
          error: message,
          ...(receipt?.conflict ? { conflict: { source: 'flat_import' as const, idempotencyKey: `${attemptedKey.slice(0, SERVER_IMPORT_KEY_LENGTH)}:${receipt.index}`, message } } : {}),
        };
      }
      creation = null; return { success: true };
    },
    async export(kind, filters) {
      const all = await readAll(filters); if (!all.success || !all.data) return { success: false, error: all.error };
      const csv = (rows: unknown[][]) => '\ufeff' + rows.map(row => row.map(value => { const text = String(value ?? ''); return '"' + (/^[\s]*[=+@-]/.test(text) ? "'" + text : text).replace(/"/g, '""') + '"'; }).join(',')).join('\r\n');
      if (kind === 'contacts') return { success: true, data: csv([['邮箱','名','姓','公司名','职位 / Title','电话','WhatsApp','LinkedIn','国家','语言','客户类型','业务类型','网站','联系状态','发送阶段','负责人','客户阶段','标签','一级来源','二级来源','导入批次来源','备注','创建时间','更新时间'], ...all.data.map(row => [row.email,row.firstName,row.lastName,row.companyName,row.title,row.phone,row.whatsapp,row.linkedinUrl,row.country,row.language,row.clientType === 'agent' ? '代理' : row.clientType === 'direct' ? '直客' : row.clientType,row.businessType,row.website,centerContactDisplayStatus(row),row.stage,row.ownerName,row.relationshipStage,row.tags.join('、'),row.sourceLevel1,row.sourceLevel2,row.source,centerContactRemark(row.extra),row.createdAt,row.updatedAt])]) };
      const rows: unknown[][] = [];
      for (const row of all.data) {
        const result = await invoke<CenterContactDetail>(ONLINE_CHANNELS.CONTACT_DETAIL, { contactId: row.contactId, customerId: row.customerId });
        if (!isCurrent()) return {success:false,error:'账号或权限已变化'};
        if (!result.ok) return { success: false, error: result.error.message };
        if (result.data.supplementAvailable === false) return { success: false, error: '请联网加载完整跟进记录后导出' };
        for (const activity of result.data.activities) rows.push([row.email,[row.firstName,row.lastName].filter(Boolean).join(' '),activity.note,activity.occurredAt ?? activity.createdAt]);
      }
      return { success: true, data: csv([['联系人邮箱','姓名','跟进内容','时间'], ...rows]) };
    },
    canDelete:id=>!!records.get(id)?.canDelete,
    deleteBatch:remove,delete:id=>remove([id]),
  };
}

/** Original drawer delegates full file bytes and stable, repeatable batches to the center. */
export function createCenterImportPort(invoke: CenterInvoke, operations: boolean, refresh: () => void, isCurrent = () => true): ImportDrawerPort {
  let preview: ImportPreview | null = null;
  let prepared: { fingerprint: string; batches: Array<{ offset: number; payload: ImportRequest }>; imported: number; skipped: number } | null = null;
  let blocked: { conflicts: LeadIngressConflictNotice[]; receipt: ImportReceipt; resolved: number; failure?: string } | null = null;
  const attemptKey = (key: string, index: number) => `${key.slice(0, SERVER_IMPORT_KEY_LENGTH)}:${index}`;
  const completeReceipt = (receipt: ImportReceipt) => {
    if (!prepared) return;
    prepared.imported += receipt.rows.filter(row => row.status === 'created').length;
    prepared.skipped += receipt.rows.filter(row => row.status === 'duplicate').length;
    prepared.batches.shift();
  };
  const run = async (): Promise<ImportExecutionResult> => {
    if (!prepared) return { success: false, error: '请重新预览文件' };
    while (prepared.batches.length) {
      const request = prepared.batches[0]!.payload;
      const result = await invoke<ImportReceipt>(ONLINE_CHANNELS.IMPORT, request);
      if (!isCurrent()) return { success: false, error: '账号已切换，请重新导入' };
      if (!result.ok) { refresh(); return { success: false, error: result.error.message }; }
      const conflictRows = result.data.rows.filter(row => row.status === 'restricted_conflict' && row.conflict);
      if (conflictRows.length) {
        const conflicts = conflictRows.map(conflictRow => ({
          source: 'flat_import',
          idempotencyKey: attemptKey(request.idempotencyKey, conflictRow.index),
          rowLabel: `第 ${conflictRow.index + IMPORT_ROW_OFFSET} 行`,
          message: conflictRow.message ?? '存在冲突，需要确认后才能继续',
        } satisfies LeadIngressConflictNotice));
        const failure = result.data.rows.find(row => !['created', 'duplicate'].includes(row.status) && !row.conflict)?.message;
        blocked = { conflicts, receipt: result.data, resolved: 0, ...(failure ? { failure } : {}) };
        refresh();
        return { success: false, error: conflicts[0]!.message, conflict: conflicts[0] };
      }
      if (result.data.rows.some(row => !['created', 'duplicate'].includes(row.status))) {
        refresh();
        return { success: false, error: result.data.rows.find(row => !['created', 'duplicate'].includes(row.status))?.message ?? '部分行未导入，请核对文件内容' };
      }
      completeReceipt(result.data);
    }
    const data = { imported: prepared.imported, skipped: prepared.skipped }; prepared = null; refresh(); return { success: true, data };
  };
  return {
    async preview(input) {
      const result = await invoke<ImportPreview>(ONLINE_CHANNELS.PREVIEW, input);
      if (!isCurrent()) return { success: false, error: '账号已切换，请重新导入' };
      if (!result.ok) return { success: false, error: result.error.message };
      preview = result.data; prepared = null;
      const mapping = leadImportMapping(result.data.headers);
      const suggestedMapping = Object.fromEntries(Object.entries(mapping).map(([field,header])=>[header,field]));
      return { success: true, data: { headers: result.data.headers, previewRows: result.data.rows.slice(0, 20).map(row => result.data.headers.map(header => row[header] ?? '')), totalRows: result.data.rows.length, suggestedMapping, duplicateEmails: [] } };
    },
    async execute(input) {
      if (!isCurrent()) return { success: false, error: '账号已切换，请重新导入' };
      if (!preview) return { success: false, error: '请重新预览文件' };
      const mapping = Object.fromEntries(Object.entries(input.mapping).filter(([, field]) => field).map(([header, field]) => [field, header]));
      const fingerprint = importFingerprint(input, mapping);
      if (prepared && prepared.fingerprint !== fingerprint) return { success: false, error: '字段映射已改变，请重新预览' };
      if (!prepared) {
        if (new Set(Object.values(input.mapping).filter(Boolean)).size !== Object.values(input.mapping).filter(Boolean).length) return {success:false,error:'同一个字段只能匹配一列'};
        const companyFields = new Map<string,Record<string,string>>();
        const rows = [];
        for (const [index,raw] of preview.rows.entries()) {
          const fields = Object.fromEntries(Object.entries(mapping).map(([field,header])=>[field,(raw[header]??'').trim()]));
          const companyName=fields.companyName??'';
          const normalized=companyName.toLowerCase();
          const company=companyFields.get(normalized)??{};
          for (const key of ['country','customerType','businessType','website']) {
            if (fields[key] && company[key] && fields[key]!==company[key]) return {success:false,error:`第 ${index+IMPORT_ROW_OFFSET} 行与同公司其他行的公司资料不一致，请核对国家、客户类型、业务类型和网站`};
            if (fields[key]) company[key]=fields[key]!;
          }
          companyFields.set(normalized,company);
          const customerKey=await companyImportKey(companyName);
          const row={...fields,customerKey,companyName,email:(fields.email??'').toLowerCase(),rawRow:raw};
          const issue=importRowIssue(row);if(issue)return {success:false,error:`第 ${index+IMPORT_ROW_OFFSET} 行：${issue}`};
          rows.push(row);
        }
        const result = prepareImportRequests({ source: 'desktop-import', sourceDetail: preview.fileName, kind: operations ? 'operations' : 'personal', companyMatching:true, mapping }, rows);
        if (!result.ok) return { success: false, error: result.error.message };
        prepared = { fingerprint, batches: result.data, imported: 0, skipped: 0 };
      }
      return run();
    },
    async continueAfterConflict(conflict) {
      const index = blocked?.conflicts.findIndex(item => item.source === conflict.source && item.idempotencyKey === conflict.idempotencyKey) ?? -1;
      if (!blocked || index < 0) {
        return { success: false, error: '冲突上下文已变化，请重新预览文件' };
      }
      blocked.conflicts.splice(index, 1);
      blocked.resolved += 1;
      if (blocked.conflicts.length) return { success: false, error: blocked.conflicts[0]!.message, conflict: blocked.conflicts[0] };
      if (blocked.failure) {
        const message = blocked.failure;
        blocked = null;
        prepared = null;
        return { success: false, error: `部分行未导入：${message}` };
      }
      completeReceipt(blocked.receipt);
      if (prepared) prepared.imported += blocked.resolved;
      blocked = null;
      return run();
    },
  };
}
