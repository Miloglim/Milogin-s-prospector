import { LEAD_LIMITS, type ImportFileContent, type ImportPreview, type ImportRow, type ImportRequest, type Result } from '../../../shared/online-crm';
const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;
/** A deterministic local guard so a partially retried batch cannot use a changed file or mapping. */
export function importFingerprint(input: ImportFileContent, mapping: Record<string, string>): string {
 let hash = FNV_OFFSET;
 const value = `${input.type}\u0000${input.encoding ?? ''}\u0000${input.data}\u0000${JSON.stringify(Object.entries(mapping).sort(([a], [b]) => a.localeCompare(b)))}`;
 for (let index = 0; index < value.length; index++) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, FNV_PRIME); }
 return (hash >>> 0).toString(16);
}
/** Match original CSV/XLSX headers without silently selecting ambiguous aliases. */
export function autoMapping(headers: string[]): Record<string, string> {
  const aliases: Record<string, string[]> = { customerKey: ['customerkey', '客户编号', '来源客户编号', 'id'], companyName: ['companyname', 'company', '公司', '公司名称'], customerType: ['customertype', '客户类型', '客户类别'], email: ['email', '邮箱', '电子邮件'], name: ['name', '联系人', '姓名'], country: ['country', '国家'] };
  return Object.fromEntries(Object.keys(aliases).map(field => { const matches = headers.filter(header => aliases[field]!.includes(header.toLowerCase().replace(/[\s_-]/g, ''))); return [field, matches.length === 1 ? matches[0]! : '']; }));
}
export function mappedImportRows(preview: ImportPreview, mapping: Record<string, string>): ImportRow[] {
 return preview.rows.map(raw => ({ customerKey: (raw[mapping.customerKey ?? ''] ?? '').trim(), companyName: (raw[mapping.companyName ?? ''] ?? '').trim(), email: (raw[mapping.email ?? ''] ?? '').trim().toLowerCase(), name: (raw[mapping.name ?? ''] ?? '').trim(), country: (raw[mapping.country ?? ''] ?? '').trim(), ...(mapping.customerType ? {customerType:(raw[mapping.customerType]??'').trim()} : {}), rawRow: raw }));
}
export function prepareImportRequests(base: Omit<ImportRequest, 'rows' | 'idempotencyKey'>, rows: ImportRow[]): Result<Array<{ offset: number; payload: ImportRequest }>> {
 const batches: Array<{ offset: number; payload: ImportRequest }> = [];
 let offset = 0; let payload: ImportRequest = { ...base, idempotencyKey: crypto.randomUUID(), rows: [] };
 for (const row of rows) {
  const candidate = { ...payload, rows: [...payload.rows, row] };
  if (candidate.rows.length > LEAD_LIMITS.batchRows || new Blob([JSON.stringify(candidate)]).size > LEAD_LIMITS.bodyBytes) {
   if (payload.rows.length) { batches.push({ offset, payload }); offset += payload.rows.length; }
   payload = { ...base, idempotencyKey: crypto.randomUUID(), rows: [row] };
   if (new Blob([JSON.stringify(payload)]).size > LEAD_LIMITS.bodyBytes) return { ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: `第 ${offset + 1} 条记录过大，请缩减无关原始列后重选文件` } };
  } else payload = candidate;
 }
 if (payload.rows.length) batches.push({ offset, payload });
 return { ok: true, data: batches };
}
