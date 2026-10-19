import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AutoComplete, Button, Checkbox, Input, Select, Space, Table } from 'antd';
import { ONLINE_CHANNELS, WORKBOOK_LIMITS, autoWorkbookMapping, buildWorkbookPlan, prepareWorkbookRequests, workbookRowIssue } from '../../../shared/online-crm';
import type { ImportPreview, Result, WorkbookMapping, WorkbookPlanRow, WorkbookImportRequest, WorkbookImportReceipt, WorkbookImportRow } from '../../../shared/online-crm';

const PAGE_ROWS = 5;
const FIELDS: Record<string, string> = { sourceRef: '来源引用', companyName: '公司名称', customerRef: '所属客户引用', name: '姓名', email: '邮箱', phone: '电话', title: '职位', country: '国家', businessType: '业务类型', developmentRestriction: '开发限制', sourceCreatedAt: '来源创建日期' };
const REQUIRED_FIELDS = { customer: ['sourceRef', 'companyName'], contact: ['sourceRef', 'customerRef', 'name', 'email'] };
const OPTIONAL_FIELDS = { customer: ['country', 'businessType', 'developmentRestriction', 'sourceCreatedAt'], contact: ['phone', 'title', 'country'] };
const STATUS: Record<string, string> = { created: '已导入', appended: '已追加', duplicate: '重复', invalid: '需修正', unmatched: '未关联', ambiguous: '关联歧义', restricted_conflict: '受限冲突' };
const SUCCESS = new Set(['created', 'appended', 'duplicate']);
const normalizedRef = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();
type Props = { source: string; sourceDetail: string; kind: 'operations' | 'personal'; onImported: () => void; onLocked: (locked: boolean) => void; onFailure: (result: Extract<Result<unknown>, { ok: false }>) => void; onDone?: () => void };

/** The exact pending request survives connection failures; known row results remain inspectable. */
export function WorkbookImportPanel({ source, sourceDetail, kind, onImported, onLocked, onFailure, onDone }: Props) {
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [customerSheet, setCustomerSheet] = useState<string>(); const [contactSheet, setContactSheet] = useState<string>();
  const [mapping, setMapping] = useState<WorkbookMapping>({ customer: {}, contact: {} });
  const [confirmed, setConfirmed] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [edits, setEdits] = useState<Record<string, Partial<WorkbookImportRow>>>({});
  const [completed, setCompleted] = useState<Set<string>>(new Set());
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [receipts, setReceipts] = useState<WorkbookImportReceipt[]>([]);
  const [editing, setEditing] = useState<WorkbookPlanRow | null>(null);
  const [reviewed, setReviewed] = useState<Set<string>>(new Set()); const [reviewCategory, setReviewCategory] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const queue = useRef<WorkbookImportRequest[]>([]); const generation = useRef(0); const lock = useRef(false);
  const completedRef = useRef(new Set<string>());
  const keyOf = (row: WorkbookImportRow) => JSON.stringify([row.entity, row.sheetName, row.rowNumber]);
  const sheets = preview?.sheets ?? [];
  const plan = useMemo(() => buildWorkbookPlan(sheets.find(sheet => sheet.sheetName === customerSheet), sheets.find(sheet => sheet.sheetName === contactSheet), mapping), [preview, customerSheet, contactSheet, mapping]);
  const customerRefs = new Map<string, WorkbookImportRow[]>(); const entityRefs = new Map<string, number>();
  for (const row of [...plan.customers, ...plan.contacts]) {
    const input = { ...row.input, ...edits[keyOf(row.input)] };
    const ref = normalizedRef(input.sourceRef); const identity = `${input.entity}:${ref}`;
    entityRefs.set(identity, (entityRefs.get(identity) ?? 0) + 1);
    if (input.entity === 'customer') customerRefs.set(ref, [...(customerRefs.get(ref) ?? []), input]);
  }
  const all = [...plan.customers, ...plan.contacts].map(row => {
    const input = { ...row.input, ...edits[keyOf(row.input)] }; const key = keyOf(input);
    const categoryIssue = row.issue?.includes('关系状态待确认') && !reviewed.has(key) ? row.issue : undefined;
    let issue = workbookRowIssue(input) || categoryIssue || sheets.find(sheet => sheet.sheetName === input.sheetName)?.error || issues[key];
    if ((entityRefs.get(`${input.entity}:${normalizedRef(input.sourceRef)}`) ?? 0) > 1) issue = '来源引用重复，请修正';
    if (input.entity === 'contact' && !issue) {
      const parents = customerRefs.get(normalizedRef(input.customerRef ?? '')) ?? [];
      if (parents.length !== 1) issue = parents.length ? '所属客户引用重复，请修正' : '所属客户未关联，请修正';
    }
    return { ...row, key, input, issue };
  });
  const waiting = all.filter(row => !completed.has(row.key));
  const receiptRows = useMemo(() => receipts.flatMap(receipt => receipt.rows.map(row => ({ ...row, batchId: receipt.batchId }))), [receipts]);
  const locked = busy || pendingCount > 0;
  useEffect(() => { onLocked(locked || receipts.length > 0); }, [locked, receipts.length]);
  useEffect(() => () => { generation.current++; }, []);
  async function invoke<T>(channel: string, payload?: unknown): Promise<Result<T>> {
    try {
      const response = await window.api.invoke(channel, ...(payload === undefined ? [] : [payload])) as Result<T>;
      if (!response || typeof response.ok !== 'boolean') return { ok: false, error: { code: 'UNAVAILABLE', message: '客户中心响应不完整，请重试' } };
      if (!response.ok && (!response.error || typeof response.error.code !== 'string' || typeof response.error.message !== 'string')) return { ok: false, error: { code: 'UNAVAILABLE', message: '客户中心响应不完整，请重试' } };
      return response;
    }
    catch { /* An unknown transport outcome must retain its original command. */ return { ok: false, error: { code: 'UNAVAILABLE', message: '客户中心连接中断，请重试' } }; }
  }
  async function selectFile() {
    if (lock.current || pendingCount) return;
    lock.current = true; setBusy(true); const current = generation.current;
    const result = await invoke<ImportPreview>(ONLINE_CHANNELS.WORKBOOK_PREVIEW);
    if (current !== generation.current) return;
    lock.current = false; setBusy(false);
    if (!result.ok) { setError(result.error.message); onFailure(result); return; }
    if (!result.data || !Array.isArray(result.data.sheets)) { setError('工作簿预览不完整，请重新选择'); return; }
    const entries = result.data.sheets ?? [];
    const customer = entries.find(sheet => sheet.sheetName === '客户管理'); const contact = entries.find(sheet => sheet.sheetName === '联系人管理');
    setPreview(result.data); setCustomerSheet(customer?.sheetName); setContactSheet(contact?.sheetName);
    setMapping({ customer: autoWorkbookMapping(customer?.headers ?? [], 'customer'), contact: autoWorkbookMapping(contact?.headers ?? [], 'contact') });
    setEdits({}); setIssues({}); setCompleted(new Set()); completedRef.current = new Set(); setReceipts([]); setReviewed(new Set()); setConfirmed(false); setEditing(null); setError('');
  }
  function selectSheet(entity: 'customer' | 'contact', value?: string) {
    if (entity === 'customer') setCustomerSheet(value); else setContactSheet(value);
    setMapping(previous => ({ ...previous, [entity]: autoWorkbookMapping(sheets.find(sheet => sheet.sheetName === value)?.headers ?? [], entity) }));
    setEdits({}); setIssues({}); setConfirmed(false); setEditing(null);
  }
  async function submit() {
    if (lock.current || !confirmed) return;
    if (plan.customers.length > WORKBOOK_LIMITS.entityRows || plan.contacts.length > WORKBOOK_LIMITS.entityRows || all.length > WORKBOOK_LIMITS.totalRows) { setError('所选客户或联系人表超过导入行数限制'); return; }
    if (sheets.some(sheet => [customerSheet, contactSheet].includes(sheet.sheetName) && sheet.error)) { setError('所选表读取不完整，请重新选择'); return; }
    const current = generation.current; lock.current = true; setBusy(true); setError('');
    const finishedCustomers = new Set(all.filter(row => row.input.entity === 'customer' && completedRef.current.has(row.key)).map(row => normalizedRef(row.input.sourceRef)));
    const pendingEntity = queue.current[0]?.rows[0]?.entity;
    for (const entity of ['customer', 'contact'] as const) {
      if (pendingEntity === 'contact' && entity === 'customer') continue;
      if (!queue.current.length) {
        const rows = all.filter(row => row.input.entity === entity && !row.issue && !completedRef.current.has(row.key) && (entity === 'customer' || finishedCustomers.has(normalizedRef(row.input.customerRef ?? '')))).map(row => row.input);
        if (!rows.length) continue;
        const prepared = prepareWorkbookRequests({ source: source.trim(), sourceDetail, kind, idempotencyKey: crypto.randomUUID() }, rows);
        if (!prepared.ok) { setError(prepared.error.message); break; }
        queue.current = prepared.data; setPendingCount(queue.current.length);
      }
      while (queue.current.length) {
        const request = queue.current[0]!;
        const result = await invoke<WorkbookImportReceipt>(ONLINE_CHANNELS.WORKBOOK_IMPORT, request);
        if (current !== generation.current) return;
        if (!result.ok) {
          if (['INVALID_INPUT', 'PAYLOAD_TOO_LARGE'].includes(result.error.code)) {
            // Center validation rejects these commands before any row can be written.
            const rejected = Object.fromEntries(request.rows.map(row => [keyOf(row), result.error.message]));
            setIssues(previous => ({ ...previous, ...rejected })); queue.current = []; setPendingCount(0);
          }
          setError(result.error.message); onFailure(result); lock.current = false; setBusy(false); return;
        }
        // A malformed receipt is an unknown outcome, so retry the exact request.
        if (!result.data || typeof result.data.batchId !== 'string' || !Array.isArray(result.data.rows) || result.data.rows.length !== request.rows.length || request.rows.some((row, index) => !result.data.rows.some(receipt => receipt && receipt.index === index && receipt.entity === row.entity && receipt.sheetName === row.sheetName && receipt.rowNumber === row.rowNumber && !!STATUS[receipt.status] && (row.entity !== 'customer' || !SUCCESS.has(receipt.status) || !!receipt.customerId)))) {
          setError('导入回执不完整，请重试当前批次'); lock.current = false; setBusy(false); return;
        }
        setReceipts(previous => [...previous, result.data]);
        const newIssues: Record<string, string> = {};
        for (const receipt of result.data.rows) {
          const input = request.rows[receipt.index]!; const key = keyOf(input);
          if (SUCCESS.has(receipt.status)) { completedRef.current.add(key); if (input.entity === 'customer') finishedCustomers.add(normalizedRef(input.sourceRef)); }
          else newIssues[key] = receipt.message || STATUS[receipt.status] || receipt.status;
        }
        setCompleted(new Set(completedRef.current)); setIssues(previous => ({ ...previous, ...newIssues })); queue.current.shift(); setPendingCount(queue.current.length); onImported();
      }
    }
    lock.current = false; setBusy(false);
  }
  const mappingFields = (entity: 'customer' | 'contact', fields: string[]) => <div className="import-mapping">{fields.map(field => <label key={field}>{FIELDS[field]}<Select aria-label={`${entity === 'customer' ? '客户' : '联系人'}${FIELDS[field]}列`} allowClear disabled={locked || completed.size > 0 || receipts.length > 0} value={mapping[entity][field] || undefined} placeholder="未选择" options={(sheets.find(sheet => sheet.sheetName === (entity === 'customer' ? customerSheet : contactSheet))?.headers ?? []).map(header => ({ value: header, label: header }))} onChange={value => { setMapping(previous => ({ ...previous, [entity]: { ...previous[entity], [field]: value ?? '' } })); setConfirmed(false); }} /></label>)}</div>;
  return <div className="workbook-import-panel">
    {error && <Alert type="error" showIcon message={error} />}
    <Button disabled={locked || ((completed.size > 0 || receipts.length > 0) && waiting.length > 0)} onClick={() => void selectFile()}>选择工作簿</Button>
    {preview && <>
      <div className="import-file-heading"><strong>{preview.fileName}</strong><span>{plan.customers.length} 个客户 · {plan.contacts.length} 位联系人</span></div>
      <div className="import-mapping">{(['customer', 'contact'] as const).map(entity => <label key={entity}>{entity === 'customer' ? '客户表' : '联系人表'}<Select aria-label={entity === 'customer' ? '客户表' : '联系人表'} allowClear disabled={locked || receipts.length > 0} value={entity === 'customer' ? customerSheet : contactSheet} options={sheets.filter(sheet => sheet.sheetName !== (entity === 'customer' ? contactSheet : customerSheet)).map(sheet => ({ value: sheet.sheetName, label: `${sheet.sheetName} · ${sheet.rows.length} 行` }))} onChange={value => selectSheet(entity, value)} /></label>)}</div>
      {sheets.filter(sheet => sheet.sheetName !== customerSheet && sheet.sheetName !== contactSheet).length > 0 && <div className="workbook-unselected">未选表：{sheets.filter(sheet => sheet.sheetName !== customerSheet && sheet.sheetName !== contactSheet).map(sheet => `${sheet.sheetName}（${sheet.rows.length} 行）`).join('、')}</div>}
      {(['customer', 'contact'] as const).map(entity => <section key={entity} className="customer-detail-section"><h2>{entity === 'customer' ? '客户字段' : '联系人字段'}</h2>{mappingFields(entity, REQUIRED_FIELDS[entity])}<details><summary>其他字段</summary>{mappingFields(entity, OPTIONAL_FIELDS[entity])}</details></section>)}
      <div className="import-file-heading"><strong>关联预览</strong><span>待处理 {waiting.length} 行 · 需修正 {waiting.filter(row => row.issue).length} 行</span></div>
      <Table size="small" rowKey="key" dataSource={waiting} pagination={{ pageSize: PAGE_ROWS, showSizeChanger: false }} scroll={{ x: 680 }} columns={[
        { title: '原行', width: 130, render: (_, row) => `${row.input.sheetName} · ${row.input.rowNumber}` },
        { title: '客户 / 联系人', width: 160, render: (_, row) => <div className="customer-name-cell"><strong>{row.input.companyName || row.input.name || '—'}</strong><span>{row.input.sourceRef || '—'}</span></div> },
        { title: '所属客户 / 邮箱', width: 170, render: (_, row) => row.input.entity === 'customer' ? '—' : <div className="customer-name-cell"><span>{row.input.customerRef || '—'}</span><span>{row.input.email || '—'}</span></div> },
        { title: '校验', render: (_, row) => row.issue || (row.input.entity === 'contact' && issues[all.find(customer => customer.input.sourceRef === row.input.customerRef && customer.input.entity === 'customer')?.key ?? ''] ? '等待客户修正' : '可提交') },
        { title: '', width: 60, render: (_, row) => <Button size="small" disabled={locked} onClick={() => { setReviewCategory(false); setEditing({ ...row, input: { ...row.input } }); }}>修正</Button> },
      ]} />
      {editing && <section className="customer-detail-section"><h2>修正 {editing.input.sheetName} · {editing.input.rowNumber}</h2><div className="import-mapping">{(editing.input.entity === 'customer' ? ['sourceRef', 'companyName', 'businessType', 'developmentRestriction', 'sourceCreatedAt'] : ['sourceRef', 'customerRef', 'name', 'email', 'phone', 'title']).map(field => <label key={field}>{FIELDS[field]}{field === 'customerRef' ? <AutoComplete aria-label="修正所属客户引用" value={editing.input.customerRef || undefined} options={all.filter(row => row.input.entity === 'customer').map(row => ({ value: row.input.sourceRef, label: `${row.input.companyName || '—'} · ${row.input.sourceRef} · ${row.input.rowNumber}` }))} onChange={value => setEditing(previous => previous ? { ...previous, input: { ...previous.input, customerRef: value } } : null)} /> : <Input aria-label={`工作簿修正${FIELDS[field]}`} value={String(editing.input[field as keyof WorkbookImportRow] ?? '')} onChange={event => setEditing(previous => previous ? { ...previous, input: { ...previous.input, [field]: event.target.value } } : null)} />}</label>)}</div><details><summary>来源原文</summary>{Object.entries(editing.input.rawRow).map(([field, value]) => <div key={field}>{field}：{String(value ?? '—')}</div>)}</details>{editing.issue?.includes('关系状态待确认') && <Checkbox checked={reviewCategory} onChange={event => setReviewCategory(event.target.checked)}>保留来源原文，暂不设置客户关系阶段</Checkbox>}<Space><Button disabled={locked || (!!editing.issue?.includes('关系状态待确认') && !reviewCategory)} type="primary" onClick={() => { const key = editing.key; if (reviewCategory) setReviewed(previous => new Set([...previous, key])); setEdits(previous => ({ ...previous, [key]: editing.input })); setIssues(previous => { const next = { ...previous }; delete next[key]; return next; }); setEditing(null); setConfirmed(false); }}>保存修正</Button><Button onClick={() => setEditing(null)}>取消</Button></Space></section>}
      <Checkbox disabled={locked} checked={confirmed} onChange={event => setConfirmed(event.target.checked)}>确认所选表及客户引用关联</Checkbox>
    </>}
      {receiptRows.length > 0 && <section className="customer-detail-section"><h2>导入回执</h2><p className="import-receipt-counts">{Object.entries(STATUS).map(([status, label]) => { const count = receiptRows.filter(row => row.status === status).length; return count ? `${label} ${count}` : ''; }).filter(Boolean).join(' · ')}</p><Table size="small" rowKey={row => `${row.batchId}:${row.rowId}`} dataSource={receiptRows} pagination={{ pageSize: PAGE_ROWS, showSizeChanger: false }} columns={[{ title: '原行', render: (_, row) => <div>{row.sheetName} · {row.rowNumber}<details><summary>批次</summary>{row.batchId}</details></div> }, { title: '结果', dataIndex: 'status', render: status => STATUS[status] }, { title: '说明', dataIndex: 'message' }, { title: '', width: 70, render: (_, receiptRow) => { const row = all.find(item => item.input.entity === receiptRow.entity && item.input.sheetName === receiptRow.sheetName && item.input.rowNumber === receiptRow.rowNumber); return !SUCCESS.has(receiptRow.status) && row ? completed.has(row.key) ? '已修正' : <Button size="small" disabled={locked} onClick={() => { setReviewCategory(false); setEditing({ ...row, input: { ...row.input } }); }}>修正</Button> : null; } }]} /></section>}
    <div className="workbook-import-footer"><Space><Button type="primary" loading={busy} disabled={!confirmed || (!pendingCount && !waiting.some(row => !row.issue)) || !source.trim()} onClick={() => void submit()}>{pendingCount ? '重试未完成批次' : '导入已确认行'}</Button>{receipts.length > 0 && waiting.length === 0 && <Button disabled={locked} onClick={onDone}>返回客户</Button>}</Space></div>
  </div>;
}
