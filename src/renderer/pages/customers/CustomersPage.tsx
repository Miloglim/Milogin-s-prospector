import { ImportDrawer, type ImportDrawerPort } from "../../components/ImportDrawer";
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { Alert, Button, Drawer, Form, Input, List, Select, Space, Table, Tabs, theme } from 'antd';
import { PlusOutlined, EditOutlined, SearchOutlined, PartitionOutlined } from '@ant-design/icons';
import { ONLINE_CHANNELS as CHANNEL, ONLINE_LIMITS, importRowIssue, FOLLOWUP_METHODS, FOLLOWUP_METHOD_LABELS, CONTACT_TOUCH_STATUSES, CONTACT_TOUCH_LABELS, hasContactedCustomer } from '../../../shared/online-crm';
import type { Result, LeadBootstrap, LeadPage, LeadDetail, LeadQuery, CustomerCreate, CustomerUpdate, CustomerContactInput, ImportRequest, ImportPreview, ImportReceipt, FollowupRequest, CrmStage, CustomerStage, FollowupMethod, ContactTouchStatus, PublishRequest, PublishReceipt } from '../../../shared/online-crm';
import { useOptionalIdentity } from '../../IdentityContext';

import { FollowupTasks } from './FollowupTasks';
import { Opportunities } from './Opportunities';
import type { Opportunity } from '../../../shared/online-crm';
import { CustomerLegacyShell } from './CustomerLegacyShell';
import { ContactDetailLayout, CONTACT_DETAIL_WIDTH, SectionTitle, FieldRow } from '../../components/ContactDetail';
import { autoMapping, importFingerprint, mappedImportRows, prepareImportRequests } from './customerImport';
import './customers.css';

const PAGE_SIZE = 25;
const DRAWER_WIDTH = 620;
const PREVIEW_ROWS = 5;
const HISTORICAL_RECORD_THRESHOLD_MS = 60_000;
const FOLLOWUP_PREWRITE_REJECTIONS = ['INVALID_INPUT', 'CONFLICT', 'NOT_FOUND', 'PAYLOAD_TOO_LARGE', 'RATE_LIMITED'];
const STAGES: CrmStage[] = ['reaching', 'quoting', 'trial', 'cooperating', 'lost', 'other'];
const STAGE_LABELS: Record<CrmStage, string> = { reaching: '初步联系', quoting: '报价中', trial: '试单中', cooperating: '合作中', lost: '已流失', other: '其他' };
const IMPORT_FIELDS = ['customerKey', 'companyName', 'email', 'name', 'country'] as const;
const FIELD_LABELS: Record<string, string> = { customerKey: '来源客户编号', companyName: '公司名称', email: '邮箱', name: '联系人', country: '国家' };
const RECEIPT_LABELS: Record<string, string> = { created: '已导入', duplicate: '重复', invalid: '需修正', restricted_conflict: '受限冲突' };
const BOARD_STAGES = ['cold', ...STAGES] as const;
const assignmentLabel = (value: { origin?: 'personal' | 'operations'; state: string }) => value.origin === 'personal' ? '自有' : value.state === 'owned' ? '已分配' : value.state === 'published' ? '待领取' : value.state === 'paused' ? '已暂停' : '待分配';
const stageLabel = (value: CrmStage | 'cold' | undefined) => value && value !== 'cold' ? STAGE_LABELS[value] : '未联系';
const sharedScope = (value: LeadBootstrap | null) => value?.scope === 'shared' || value?.scope === 'summary';
const defaultScope = (value: LeadBootstrap): LeadQuery['view'] => sharedScope(value) && value.capabilities.includes('leads.read.all') ? 'all' : sharedScope(value) && ['leads.import', 'leads.publish', 'followups.read'].some(permission => value.capabilities.includes(permission)) ? 'operations' : value.capabilities.includes('leads.develop') ? 'personal' : 'pool';
type View = 'table' | 'board' | 'company';
type TaskView = LeadQuery['view'] | 'unassigned' | 'operationsAssigned';
type CustomerForm = { companyName: string; country?: string; customerType?: string; businessType?: string; developmentRestriction?: string; sourceCreatedAt?: string; source?: string; sourceDetail?: string; contacts: Array<CustomerContactInput & { contactId?: number }> };
type ImportEntry = ImportReceipt & { offset: number; input?: ImportRequest; rowNumbers?: number[]; fileName?: string; correctsRowId?: string; published?: boolean };
type ImportCorrection = { originalRowId: string; rowNumber: number; entry: ImportEntry; values: ImportRequest['rows'][number] };
function parseView(): View { const value = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('view'); return value === 'board' || value === 'company' ? value : 'table'; }
const accessKey = (value: LeadBootstrap) => JSON.stringify([value.userId, value.capabilities.slice().sort(), value.scope]);

export function CustomersPage() {
  async function invoke<T>(channel: string, ...args: unknown[]): Promise<Result<T>> {
    try { return await window.api.invoke(channel, ...args) as Result<T>; }
    catch { /* Transport errors must not become local CRM writes. */ return { ok: false, error: { code: 'UNAVAILABLE', message: '客户中心连接中断，请重试' } }; }
  }
  const session = useOptionalIdentity();
  const { token } = theme.useToken();
  const tokenStyle = { '--customer-muted': token.colorTextSecondary, '--customer-border': token.colorBorderSecondary, '--customer-surface': token.colorBgContainer, '--customer-fill': token.colorFillQuaternary, '--customer-primary': token.colorPrimary } as React.CSSProperties;
  const routeRouter = useRouter({ warn: false });
  const identityKey = JSON.stringify([session?.identity?.userId, session?.identity?.crmCapabilities, session?.identity?.crmRoles, session?.identity?.mustChangePassword]);
  const [view, setView] = useState<View>(parseView);
  const [bootstrap, setBootstrap] = useState<LeadBootstrap | null>(null);
  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace || view !== 'company') return;
    const update = () => { const list = workspace.querySelector('.customer-classic-companies'); if (list) setCompanyDetailTop(list.getBoundingClientRect().top - workspace.getBoundingClientRect().top); };
    update(); const observer = new ResizeObserver(update); observer.observe(workspace);
    return () => observer.disconnect();
  }, [view, bootstrap]);
  const [detailTab, setDetailTab] = useState('info');
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [companyDetailTop, setCompanyDetailTop] = useState(0);

  const [assignment, setAssignment] = useState<LeadQuery['assignment']>();
  const [stageFilter, setStageFilter] = useState<LeadQuery['stage']>();
  const [scope, setScope] = useState<LeadQuery['view']>('personal');
  const [leads, setLeads] = useState<LeadPage>({ items: [], total: 0 });
  const [detail, setDetail] = useState<LeadDetail | null>(null);
  const [search, setSearch] = useState(''); const [page, setPage] = useState(1);
  const [listLoading, setListLoading] = useState(false);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false); const [creating, setCreating] = useState(false);
  const [selectedOpportunity, setSelectedOpportunity] = useState<Opportunity>();
  const [opportunityLocked, setOpportunityLocked] = useState(false);
  const opportunityLockRef=useRef(false);
  function updateOpportunityLock(value:boolean){opportunityLockRef.current=value;setOpportunityLocked(value);}
  const [note, setNote] = useState(''); const [stage, setStage] = useState<CustomerStage>();
  const [method, setMethod] = useState<FollowupMethod>('other'); const [occurredAt, setOccurredAt] = useState('');
  const [currentContactId, setCurrentContactId] = useState<number>(); const [contactStatus, setContactStatus] = useState<ContactTouchStatus>();
  const [followupUncertain, setFollowupUncertain] = useState(false);
  const [importKind, setImportKind] = useState<'personal' | 'operations' | 'public'>('personal');
  const [originalImportOpen, setOriginalImportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false); const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({}); const [source, setSource] = useState(''); const [sourceDetail, setSourceDetail] = useState('');
  const [receipts, setReceipts] = useState<ImportEntry[]>([]);
  const [correction, setCorrection] = useState<ImportCorrection | null>(null);
  const [correctionPending, setCorrectionPending] = useState(false);
  const pendingCorrection = useRef<ImportRequest | null>(null);
  const [form] = Form.useForm<CustomerForm>();
  const epoch = useRef(0); const listSequence = useRef(0); const detailSequence = useRef(0);
  const selected = useRef<LeadDetail | null>(null); selected.current = detail;
  const pendingImports = useRef<Array<{ payload: ImportRequest; offset: number }>>([]); const keys = useRef(new Map<string, string>());
  const pendingFollowup = useRef<FollowupRequest | null>(null); const followupBaseVersion = useRef<number | null>(null);
  const lock = useRef(false); const editSnapshot = useRef<LeadDetail | null>(null); const selectionGeneration = useRef(0); const editingRef = useRef(editing); editingRef.current = editing;
  const originalImportPreview = useRef<ImportPreview | null>(null);
  const originalImportBatches = useRef<{ signature: string; batches: Array<{ payload: ImportRequest; offset: number }> } | null>(null);
  const can = (permission: string) => bootstrap?.capabilities.includes(permission) === true;
  const editable = !!detail && (detail.canEdit ?? (can('leads.develop') && detail.ownerUserId === bootstrap?.userId));
  const canFollowup = !!detail && (detail.canFollowup ?? (can('leads.develop') && detail.ownerUserId === bootstrap?.userId));
  const canCreate = can('leads.create') && can('leads.develop');
  const canImportOperations = sharedScope(bootstrap) && can('leads.import');
  const operationsWorkspace = sharedScope(bootstrap) && (can('leads.import') || can('leads.publish') || (session?.identity?.crmRoles.includes('operations') && can('followups.read')));
  const publishCommands = useRef(new Map<string, PublishRequest>());
  const poolPreview = !!detail && detail.state === 'published' && !detail.canEdit && !detail.canFollowup && !detail.canAssign && !detail.source;
  const followupLocked = busy || followupUncertain;
  function resetDraft() {
    pendingFollowup.current = null; followupBaseVersion.current = null; setSelectedOpportunity(undefined); setNote(''); setStage(undefined); setMethod('other'); setOccurredAt(''); setCurrentContactId(undefined); setContactStatus(undefined); setFollowupUncertain(false);
  }
  function editFollowup(apply: () => void) {
    if (lock.current || pendingFollowup.current) return;
    if (followupBaseVersion.current === null && detail) followupBaseVersion.current = detail.version;
    apply();
  }
  function changeNote(value: string) { editFollowup(() => setNote(value)); }
  function changeStage(value: CustomerStage | undefined) { editFollowup(() => setStage(value)); }
  function changeMethod(value: FollowupMethod) { editFollowup(() => { setMethod(value); if (value === 'note') setContactStatus(undefined); }); }
  function changeContact(value: number | undefined) { editFollowup(() => { setCurrentContactId(value); setContactStatus(undefined); }); }
  const keyFor = (payload: unknown) => { const signature = JSON.stringify(payload); let key = keys.current.get(signature); if (!key) { key = crypto.randomUUID(); keys.current.set(signature, key); } return key; };
  function clear() {
    listSequence.current++; detailSequence.current++; selectionGeneration.current++; editSnapshot.current = null; selected.current = null;
    setAssignment(undefined); setStageFilter(undefined); setImportKind('personal'); publishCommands.current.clear();
    setListLoading(false); setBootstrap(null); setLeads({ items: [], total: 0 }); setDetail(null); setCreating(false); setEditing(false);
    setPreview(null); setReceipts([]); setCorrection(null); setCorrectionPending(false); pendingCorrection.current = null; setImportOpen(false); setOriginalImportOpen(false); setSource(''); setSourceDetail(''); setMapping({}); setNote(''); setSearch(''); setPage(1); setBusy(false);
    originalImportPreview.current = null; originalImportBatches.current = null;
    form.resetFields(); pendingImports.current = []; keys.current.clear(); lock.current = false;
    resetDraft();
  }
  function failure(result: Extract<Result<unknown>, { ok: false }>) {
    setError(result.error.message);
    if (['UNAUTHORIZED', 'FORBIDDEN', 'PASSWORD_CHANGE_REQUIRED'].includes(result.error.code)) { epoch.current++; clear(); void session?.refresh(); }
  }
  async function refresh() {
    const version = epoch.current; const sequence = ++listSequence.current; setListLoading(true);
    const result = await invoke<LeadPage>(CHANNEL.LIST, { view: scope, search, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE, ...(assignment ? { assignment } : {}), ...(stageFilter && !(view === 'board' && stageFilter === 'cold') ? { stage: stageFilter } : {}), ...(view === 'board' && scope !== 'pool' ? { followupOnly: true } : {}) });
    if (version !== epoch.current || sequence !== listSequence.current) return;
    setListLoading(false);
    if (result.ok) { setLeads(result.data); setError(''); } else failure(result);
  }
  async function openDetail(id: string, polling = false) {
    if(!polling && opportunityLockRef.current)return;
    if (!polling) { const params = new URLSearchParams(window.location.hash.split('?')[1] ?? ''); setDetailTab(params.has('taskId') ? 'tasks' : params.has('opportunityId') ? 'opportunities' : 'info'); }
    const version = epoch.current; const sequence = ++detailSequence.current;
    if (!polling) { selectionGeneration.current++; selected.current = null; setDetail(null); setEditing(false); resetDraft(); }
    const result = await invoke<LeadDetail>(CHANNEL.DETAIL, id);
    if (version !== epoch.current || sequence !== detailSequence.current || (polling && editingRef.current)) return;
    if (result.ok) { selected.current = result.data; setDetail(result.data); }
    else { if (result.error.code !== 'UNAVAILABLE') { selected.current = null; setDetail(null); } failure(result); }
  }
  async function command<T>(channel: string, payload: unknown, apply: (value: T) => void) {
    if (lock.current) return; lock.current = true; setBusy(true); setError('');
    const version = epoch.current; const selection = selectionGeneration.current; detailSequence.current++;
    const result = await invoke<T>(channel, payload);
    if (version !== epoch.current) return;
    lock.current = false; setBusy(false);
    if (result.ok) { if (selection === selectionGeneration.current) apply(result.data); void refresh(); } else failure(result);
  }
  useEffect(() => {
    epoch.current++; clear(); setError(''); const version = epoch.current;
    if (!session?.identity || session.identity.mustChangePassword) return;
    void invoke<LeadBootstrap>(CHANNEL.BOOTSTRAP).then(result => {
      if (version !== epoch.current) return;
      if (result.ok) { setBootstrap(result.data); setScope(defaultScope(result.data)); setImportKind(sharedScope(result.data) && result.data.capabilities.includes('leads.import') ? 'operations' : 'personal'); }
      else failure(result);
    });
    return () => { epoch.current++; };
  }, [identityKey]);
  useEffect(() => {
    if (!bootstrap) return;
    const target = () => { const id = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('customerId'); if (id && selected.current?.customerId !== id) void openDetail(id); };
    target(); window.addEventListener('hashchange', target); const unsubscribe = routeRouter?.subscribe('onResolved', target);
    return () => { window.removeEventListener('hashchange', target); unsubscribe?.(); };
  }, [bootstrap, routeRouter]);
  useEffect(() => {
    const onHash = () => { if (new URLSearchParams(window.location.hash.split('?')[1] ?? '').has('view')) setView(parseView()); };
    window.addEventListener('hashchange', onHash); return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    if (!bootstrap) return; void refresh(); let active = true; let polling = false; const version = epoch.current;
    const timer = setInterval(() => { void (async () => {
      if (polling) return; polling = true;
      try {
        const access = await invoke<LeadBootstrap>(CHANNEL.BOOTSTRAP);
        if (!active || version !== epoch.current) return;
        if (!access.ok) { failure(access); return; }
        if (accessKey(access.data) !== accessKey(bootstrap)) { epoch.current++; clear(); setBootstrap(access.data); setScope(defaultScope(access.data)); return; }
        if (lock.current) return;
        const detailVersion = detailSequence.current;
        await refresh();
        // A write may start and finish while LIST is pending; do not let that older poll reopen stale detail.
        if (!lock.current && detailVersion === detailSequence.current && !editingRef.current && active && version === epoch.current && selected.current) await openDetail(selected.current.customerId, true);
      } finally { polling = false; }
    })(); }, ONLINE_LIMITS.pollMs);
    return () => { active = false; clearInterval(timer); };
  }, [bootstrap, scope, assignment, stageFilter, search, page, view]);
  function startCreate() { if(opportunityLockRef.current)return; selectionGeneration.current++; resetDraft(); setEditing(false); setCreating(true); form.resetFields(); form.setFieldsValue({ source: '手动新增', contacts: [{ email: '' }] }); }
  function startEdit() { if(opportunityLockRef.current)return; if (!detail) return; editSnapshot.current = detail; setEditing(true); form.setFieldsValue({ companyName: detail.companyName, country: detail.country ?? '', customerType: detail.customerType ?? '', businessType: detail.businessType ?? '', developmentRestriction: detail.developmentRestriction ?? '', sourceCreatedAt: detail.sourceCreatedAt ?? '', contacts: detail.contacts.map(contact => ({ contactId: contact.contactId, email: contact.email ?? '', name: contact.name ?? '', country: contact.country ?? '', phone: contact.phone ?? '', whatsapp: contact.whatsapp ?? '', title: contact.title ?? '' })) }); }
  async function saveCustomer(values: CustomerForm) {
    if (creating) {
      const payload = { companyName: values.companyName, country: values.country, customerType: values.customerType, businessType: values.businessType, developmentRestriction: values.developmentRestriction, sourceCreatedAt: values.sourceCreatedAt, source: values.source?.trim() || '手动新增', sourceDetail: values.sourceDetail ?? '', contacts: values.contacts ?? [] };
      await command<LeadDetail>(CHANNEL.CREATE_CUSTOMER, { ...payload, idempotencyKey: keyFor(payload) } satisfies CustomerCreate, value => { setCreating(false); setDetail(value); selected.current = value; });
    } else if (detail && editable) {
      const payload = { customerId: detail.customerId, expectedVersion: (editSnapshot.current ?? detail).version, companyName: values.companyName, country: values.country, customerType: values.customerType, businessType: values.businessType, developmentRestriction: values.developmentRestriction, sourceCreatedAt: values.sourceCreatedAt, contacts: values.contacts ?? [] };
      await command<LeadDetail>(CHANNEL.UPDATE_CUSTOMER, { ...payload, idempotencyKey: keyFor(payload) } satisfies CustomerUpdate, value => { setEditing(false); setDetail(value); selected.current = value; });
    }
  }
  async function saveFollowup() {
    if (!detail || !canFollowup || !note.trim() || lock.current) return;
    if (!pendingFollowup.current) {
      const occurrence = occurredAt ? new Date(occurredAt) : null;
      if (occurrence && !Number.isFinite(occurrence.getTime())) { setError('请填写有效的发生时间'); return; }
      const payload: FollowupRequest = {
        customerId: detail.customerId, expectedVersion: followupBaseVersion.current ?? detail.version, note: note.trim(), method,
        ...(selectedOpportunity ? { opportunityId: selectedOpportunity.opportunityId } : {}),
        ...(stage ? { stage } : {}), ...(occurrence ? { occurredAt: occurrence.toISOString() } : {}),
        ...(currentContactId !== undefined ? { contactId: currentContactId } : {}),
        ...(method !== 'note' && currentContactId !== undefined && contactStatus ? { contactStatus } : {}),
        idempotencyKey: crypto.randomUUID(),
      };
      pendingFollowup.current = Object.freeze(payload);
    }
    lock.current = true; setBusy(true); setError('');
    const version = epoch.current; const selection = selectionGeneration.current; detailSequence.current++;
    const result = await invoke<LeadDetail>(CHANNEL.FOLLOWUP, pendingFollowup.current);
    if (version !== epoch.current) return;
    if (selection !== selectionGeneration.current) { lock.current = false; setBusy(false); if (result.ok) void refresh(); return; }
    if (result.ok) { lock.current = false; setBusy(false); setDetail(result.data); selected.current = result.data; resetDraft(); void refresh(); }
    else {
      if (FOLLOWUP_PREWRITE_REJECTIONS.includes(result.error.code)) {
        pendingFollowup.current = null; followupBaseVersion.current = null; setFollowupUncertain(false);
        // The center explicitly rejected before writing; keep editable fields and refresh the next draft's base.
        await openDetail(detail.customerId, true);
      } else setFollowupUncertain(true);
      if (version !== epoch.current) return;
      lock.current = false; setBusy(false);
      if (selection !== selectionGeneration.current) return;
      failure(result);
    }
  }
  async function selectFile() {
    if (lock.current) return; lock.current = true; setBusy(true); const version = epoch.current;
    const result = await invoke<ImportPreview>(CHANNEL.PREVIEW);
    if (version !== epoch.current) return; lock.current = false; setBusy(false);
    if (result.ok) { setPreview(result.data); setMapping(autoMapping(result.data.headers)); setReceipts([]); setCorrection(null); setError(''); pendingImports.current = []; } else failure(result);
  }
  async function importFile() {
    if (!preview || lock.current) return;
    if (!source.trim() || IMPORT_FIELDS.slice(0, 3).some(field => !mapping[field])) { setError('请填写来源，并选择客户编号、公司和邮箱列'); return; }
    if (!pendingImports.current.length) {
      if (new Set(Object.values(mapping).filter(Boolean)).size !== Object.values(mapping).filter(Boolean).length) { setError('同一原始列不能对应多个字段'); return; }
      const rows = mappedImportRows(preview, mapping);
      const prepared = prepareImportRequests({ source: source.trim(), sourceDetail, ...(importKind === 'public' ? {} : { kind: importKind }), mapping: Object.fromEntries(Object.entries(mapping).filter(([, column]) => column)) }, rows);
      if (!prepared.ok) { setError(prepared.error.message); return; } pendingImports.current = prepared.data;
    }
    const version = epoch.current; lock.current = true; setBusy(true); setError('');
    while (pendingImports.current.length) {
      const batch = pendingImports.current[0]!;
      const result = await invoke<ImportReceipt>(CHANNEL.IMPORT, batch.payload);
      if (version !== epoch.current) return;
      if (!result.ok) { lock.current = false; setBusy(false); failure(result); return; }
      setReceipts(previous => [...previous, { ...result.data, offset: batch.offset, input: batch.payload, rowNumbers: preview.rowNumbers?.slice(batch.offset, batch.offset + batch.payload.rows.length), fileName: preview.fileName }]); pendingImports.current.shift();
    }
    lock.current = false; setBusy(false); setPreview(null); void refresh();
  }
  function repairRow(entry: ImportEntry, index: number) {
    const original = entry.input?.rows[index]; const receiptRow = entry.rows.find(row => row.index === index);
    if (!original || !receiptRow || pendingCorrection.current) return;
    setCorrection({ originalRowId: receiptRow.rowId, rowNumber: entry.rowNumbers?.[index] ?? entry.offset + index + 1, entry, values: { ...original } }); setError('');
  }
  async function retryCorrection() {
    if (!correction || !correction.entry.input || lock.current) return;
    if (!pendingCorrection.current) {
      const row = { ...correction.values, customerKey: correction.values.customerKey.trim(), companyName: correction.values.companyName.trim(), email: correction.values.email.trim().toLowerCase() };
      const issue = importRowIssue(row); if (issue) { setError(issue); return; }
      const input = correction.entry.input;
      const rawRow = { ...row.rawRow };
      for (const field of IMPORT_FIELDS) { const column = input.mapping?.[field]; if (column) rawRow[column] = row[field] ?? ''; }
      const prepared = prepareImportRequests({ source: input.source, sourceDetail: input.sourceDetail, kind: input.kind, mapping: input.mapping }, [{ ...row, rawRow: { original: row.rawRow ?? {}, corrected: rawRow, repairOf: { batchId: correction.entry.batchId, rowId: correction.originalRowId, rowNumber: correction.rowNumber } } }]);
      if (!prepared.ok) { setError(prepared.error.message); return; } pendingCorrection.current = prepared.data[0]!.payload; setCorrectionPending(true);
    }
    const version = epoch.current; lock.current = true; setBusy(true); setError('');
    const result = await invoke<ImportReceipt>(CHANNEL.IMPORT, pendingCorrection.current);
    if (version !== epoch.current) return;
    lock.current = false; setBusy(false);
    if (!result.ok) { failure(result); return; }
    setReceipts(previous => [...previous, { ...result.data, offset: correction.rowNumber - 1, input: pendingCorrection.current!, rowNumbers: [correction.rowNumber], fileName: correction.entry.fileName, correctsRowId: result.data.rows.some(row => row.status === 'created' || row.status === 'duplicate') ? correction.originalRowId : undefined }]);
    pendingCorrection.current = null; setCorrectionPending(false); setCorrection(null); void refresh();
  }
  async function publishReceipt(receipt: ImportReceipt) {
    if (lock.current || !can('leads.publish') || !sharedScope(bootstrap)) return;
    let payload = publishCommands.current.get(receipt.batchId);
    if (!payload) { payload = { rowIds: receipt.rows.filter(row => row.status === 'created').map(row => row.rowId), expectedVersion: receipt.version, idempotencyKey: crypto.randomUUID() }; publishCommands.current.set(receipt.batchId, payload); }
    const version = epoch.current; lock.current = true; setBusy(true); setError('');
    const result = await invoke<PublishReceipt>(CHANNEL.PUBLISH, receipt.batchId, payload);
    if (version !== epoch.current) return;
    lock.current = false; setBusy(false);
    if (result.ok) { publishCommands.current.delete(receipt.batchId); setReceipts(previous => previous.map(item => item.batchId === receipt.batchId ? { ...item, published: true } : item)); void refresh(); } else failure(result);
  }
  function openImport() {
    setImportKind(canImportOperations ? 'operations' : 'personal');
    setSource('desktop-import'); setSourceDetail(''); setOriginalImportOpen(true);
  }
  const originalImportPort:ImportDrawerPort = {
    async preview(input) {
      const generation=epoch.current;
      const result=await invoke<ImportPreview>(CHANNEL.PREVIEW,input);
      if(generation!==epoch.current)return {success:false,error:"账号已切换，请重新导入"};
      if(!result.ok)return {success:false,error:result.error.message};
      originalImportPreview.current=result.data;originalImportBatches.current=null;
      const suggested=autoMapping(result.data.headers);
      return {success:true,data:{headers:result.data.headers,previewRows:result.data.rows.slice(0,20).map(row=>result.data.headers.map(h=>row[h]??'')),totalRows:result.data.rows.length,suggestedMapping:Object.fromEntries(Object.entries(suggested).filter(([,h])=>h).map(([field,h])=>[h,field==='name'?'firstName':field])),duplicateEmails:[]}};
    },
    async execute(input) {
      const generation=epoch.current;
      const file=originalImportPreview.current;
      if(!file)return {success:false,error:'请重新选择文件'};
      const mapping=Object.fromEntries(Object.entries(input.mapping).filter(([,f])=>f).map(([h,f])=>[f==='firstName'?'name':f,h]));
      const signature=importFingerprint(input,mapping);
      if(originalImportBatches.current && originalImportBatches.current.signature!==signature){
        return {success:false,error:'文件或字段映射已改变，请返回重新预览'};
      }
      if(!originalImportBatches.current){
        const rows=mappedImportRows(file,mapping).map(row=>({...row,customerKey:row.customerKey||row.email}));
        const prepared=prepareImportRequests({source:'desktop-import',sourceDetail:'',kind:canImportOperations?'operations':'personal',mapping},rows);
        if(!prepared.ok)return {success:false,error:prepared.error.message};
        originalImportBatches.current={signature,batches:prepared.data};
      }
      let imported=0,skipped=0;
      while(originalImportBatches.current?.batches.length){
        const batch=originalImportBatches.current.batches[0]!;const result=await invoke<ImportReceipt>(CHANNEL.IMPORT,batch.payload);
        if(generation!==epoch.current)return {success:false,error:'账号已切换，请重新导入'};
        if(!result.ok)return {success:false,error:result.error.message};
        imported+=result.data.rows.filter(row=>row.status==='created').length;
        skipped+=result.data.rows.filter(row=>row.status==='duplicate').length;
        if(result.data.rows.some(row=>row.status!=='created'&&row.status!=='duplicate')){void refresh();return {success:false,error:'部分行未导入，请核对文件内容；已成功记录不会重复创建'};}
        originalImportBatches.current.batches.shift();
      }
      originalImportBatches.current=null;void refresh();return {success:true,data:{imported,skipped}};
    }
  };
  const scopeOptions = [
    ...(operationsWorkspace ? [{ value: 'operations', label: '我的线索' }, { value: 'unassigned', label: '待分配' }, { value: 'operationsAssigned', label: '已分配' }] : can('leads.develop') ? [{ value: 'personal', label: '自有线索' }, { value: 'assigned', label: '分配线索' }] : []),
  ];
  const additionalViews = [
    ...(operationsWorkspace && can('leads.develop') ? [{ value: 'personal', label: '个人客户' }, { value: 'assigned', label: '分配给我' }] : []),
    ...(can('leads.claim') ? [{ value: 'pool', label: '公共池' }] : []),
    ...(sharedScope(bootstrap) && can('leads.read.all') ? [{ value: 'all', label: '全部客户' }] : []),
  ];
  function resetList() { listSequence.current++; setLeads({ items: [], total: 0 }); setPage(1); }
  function changeTask(value: TaskView) {
    selectionGeneration.current++; resetDraft(); detailSequence.current++; selected.current = null; setDetail(null); resetList();
    setScope(value === 'unassigned' || value === 'operationsAssigned' ? 'operations' : value);
    setAssignment(value === 'unassigned' ? 'unassigned' : value === 'operationsAssigned' ? 'assigned' : undefined);
    if (value === 'pool') { setStageFilter(undefined); setView('table'); }
  }
  const taskView = scope === 'operations' && assignment ? assignment === 'unassigned' ? 'unassigned' : 'operationsAssigned' : scope;
  const preparedRows = preview ? mappedImportRows(preview, mapping).map((row, index) => ({ ...row, index, rowNumber: preview.rowNumbers?.[index] ?? index + 1, issue: importRowIssue(row) })) : [];
  const customerFields = <Form form={form} disabled={busy} layout="vertical" onFinish={values => void saveCustomer(values)}>
    <Form.Item name="companyName" label="公司" rules={[{ required: true, whitespace: true, message: '请填写公司名称' }]}><Input /></Form.Item>
    <Form.Item name="country" label="国家"><Input /></Form.Item>
    <div className="import-mapping"><Form.Item name="customerType" label="客户类型"><Select allowClear options={[{value:'代理',label:'代理'},{value:'直客',label:'直客'}]} /></Form.Item><Form.Item name="businessType" label="业务类型"><Input /></Form.Item><Form.Item name="developmentRestriction" label="开发限制"><Input /></Form.Item><Form.Item name="sourceCreatedAt" label="来源创建日期"><Input /></Form.Item></div>
    {creating && <Space align="start"><Form.Item name="source" label="来源" rules={[{ required: true, whitespace: true }]}><Input /></Form.Item><Form.Item name="sourceDetail" label="来源说明"><Input /></Form.Item></Space>}
    <Form.List name="contacts">{(fields, { add, remove }, { errors }) => <>
      {fields.map(field => <div key={field.key} className="border border-gray-200 rounded p-3 mb-3">
        <Form.Item name={[field.name, 'contactId']} hidden><Input /></Form.Item>
        <Space align="start"><Form.Item name={[field.name, 'name']} label="姓名"><Input /></Form.Item><Form.Item name={[field.name, 'email']} label="邮箱" rules={[{ type: 'email', message: '请填写有效邮箱' }]}><Input /></Form.Item></Space>
        <Space align="start"><Form.Item name={[field.name, 'phone']} label="电话"><Input /></Form.Item><Form.Item name={[field.name, 'whatsapp']} label="WhatsApp"><Input /></Form.Item><Form.Item name={[field.name, 'title']} label="职位"><Input /></Form.Item><Form.Item name={[field.name, 'country']} label="国家"><Input /></Form.Item></Space>
        <Button size="small" disabled={!!form.getFieldValue(['contacts', field.name, 'contactId'])} onClick={() => remove(field.name)}>移除联系人</Button>
      </div>)}<Form.ErrorList errors={errors} /><Button onClick={() => add({ email: '' })}>添加联系人</Button>
    </>}</Form.List><Button type="primary" htmlType="submit" loading={busy} className="mt-4 ml-3">保存</Button>
  </Form>;
  const DetailDrawer = view === 'table' && !creating && !editing ? ContactDetailLayout : Drawer;
  return <div ref={workspaceRef} className="customer-workspace" style={tokenStyle}>
    {error && !creating && !detail && !importOpen && <Alert type="error" showIcon message={error} />}
    {bootstrap && <CustomerLegacyShell
      bootstrap={bootstrap}
      leads={leads}
      listLoading={listLoading}
      page={page}
      setPage={setPage}
      search={search}
      setSearch={value => { resetList(); setSearch(value); }}
      taskView={taskView}
      scope={scope}
      scopeOptions={scopeOptions}
      additionalViews={additionalViews}
      stageFilter={stageFilter}
      setStageFilter={value => { resetList(); setStageFilter(value); }}
      view={view}
      setView={setView}
      canCreate={canCreate}
      canImport={canCreate || canImportOperations}
      onChangeTask={changeTask}
      onOpenDetail={customerId => void openDetail(customerId)}
      onStartCreate={startCreate}
      onOpenImport={openImport}
      assignmentLabel={assignmentLabel}
      stageLabel={stageLabel}
      selectedCustomerId={detail?.customerId}
    />}
    <DetailDrawer rootClassName={view === 'board' && !creating ? 'app-drawer-below-titlebar customer-classic-floating-detail' : view === 'company' && !creating ? 'customer-classic-company-detail' : view === 'table' ? 'customer-classic-contact-detail' : 'app-drawer-below-titlebar'} mask={view === 'table' || creating} closable={view !== 'table' && !creating} getContainer={view === 'company' && !creating ? false : undefined} rootStyle={{ ...tokenStyle, ...(view === 'company' && !creating ? { position: 'absolute' as const, top: companyDetailTop, height: `calc(100% - ${companyDetailTop}px)` } : { top: 'var(--app-titlebar-height)', height: 'calc(100% - var(--app-titlebar-height))' }) }} width={view === 'board' && !creating ? 'clamp(300px, 30vw, 460px)' : view === 'company' && !creating ? 'calc(100% - 330px)' : view === 'table' && !creating && !editing ? CONTACT_DETAIL_WIDTH : DRAWER_WIDTH} open={creating || !!detail} title={creating ? '新增客户' : undefined} onClose={() => { if(opportunityLockRef.current)return; selectionGeneration.current++; resetDraft(); detailSequence.current++; selected.current = null; setDetail(null); setCreating(false); setEditing(false); }}>
      {error && <Alert type="error" showIcon message={error} className="mb-3" />}
      {(creating || editing) ? customerFields : detail && <>
        <div className="customer-detail-primary"><div><div className="customer-contact-heading"><h2>{view === 'table' ? detail.contacts[0]?.name || detail.companyName : detail.companyName}</h2>{view === 'table' && <Space size={0}>
          <Button type="text" size="small" icon={<SearchOutlined />} title="在收件箱中搜索" disabled={!detail.contacts[0]?.email} onClick={() => { window.location.hash = `#/inbox?search=${encodeURIComponent(detail.contacts[0]?.email ?? '')}`; }} />
          <Button type="text" size="small" icon={<PartitionOutlined />} title="在跟进看板中查看" disabled={!hasContactedCustomer(detail.contacts) || scope === 'pool'} onClick={() => setView('board')} />
          {editable && <Button type="text" size="small" icon={<EditOutlined />} title="编辑资料" disabled={opportunityLocked} onClick={startEdit} />}
        </Space>}</div>{view === 'table' && <div className="customer-contact-email">{detail.contacts[0]?.email || '—'}</div>}</div><Space wrap>{view !== 'table' && editable && <Button size="small" disabled={opportunityLocked} onClick={startEdit}>编辑资料</Button>}{canFollowup && <Button size="small" type="text" disabled={busy} onClick={() => { setDetailTab('followup'); requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[aria-label="跟进记录"]')?.focus()); }}>记录跟进</Button>}</Space></div>
        {!poolPreview && <Tabs className={view === 'table' ? 'contact-detail-tabs' : undefined} size="small" activeKey={detailTab} onChange={setDetailTab} items={[{key:'info',label:'基本信息'},...(view === 'table' ? [{key:'company',label:'公司背调',disabled:true}] : [{key:'prefs',label:'偏好设置',disabled:true},{key:'emails',label:'邮件往来',disabled:true}]),{key:'followup',label:view === 'table' ? '往来记录' : '跟进记录'},{key:'tasks',label:'下一步'},{key:'opportunities',label:'商机'}]} />}
        <div className={!poolPreview ? `customer-tab-content customer-tab-${detailTab}` : undefined}>
        {!poolPreview && <div className="customer-contact-profile">
          <SectionTitle>身份信息</SectionTitle>
          <FieldRow label="公司"><span aria-label="客户公司">{detail.companyName}</span></FieldRow>
          <FieldRow label="国家"><span>{detail.country || '—'}</span></FieldRow>
          <FieldRow label="客户类型"><span>{detail.customerType || '—'}</span></FieldRow><FieldRow label="业务类型"><span>{detail.businessType || '—'}</span></FieldRow>
          <SectionTitle>联系方式</SectionTitle>
          {detail.contacts.length ? detail.contacts.map(contact => <div key={contact.contactId} className="customer-contact-fields">
            <FieldRow label="姓名"><span>{contact.name || '—'}</span></FieldRow>
            <FieldRow label="职位"><span>{contact.title || '—'}</span></FieldRow>
            <FieldRow label="邮箱"><span className="customer-contact-email">{contact.email || '—'}</span></FieldRow>
            <FieldRow label="电话"><span>{contact.phone || '—'}</span></FieldRow>
            <FieldRow label="国家"><span>{contact.country || '—'}</span></FieldRow>
            <FieldRow label="状态"><span>{contact.touchStatus ? CONTACT_TOUCH_LABELS[contact.touchStatus] : '未触达'}</span></FieldRow>
          </div>) : <span className="customer-contact-empty">暂无联系人</span>}
          <SectionTitle>跟进信息</SectionTitle>
          <FieldRow label="跟进人"><span>{detail.ownerName || '—'}</span></FieldRow>
          <FieldRow label="客户阶段"><span>{stageLabel(detail.stage)}</span></FieldRow>
          <FieldRow label="开发限制"><span>{detail.developmentRestriction || '—'}</span></FieldRow>
          <SectionTitle>系统信息</SectionTitle>
          <FieldRow label="来源"><span>{detail.source || '—'}</span></FieldRow>
          <FieldRow label="来源说明"><span>{detail.sourceDetail || '—'}</span></FieldRow>
          <FieldRow label="来源日期"><span>{detail.sourceCreatedAt ? new Date(detail.sourceCreatedAt).toLocaleString('zh-CN') : '—'}</span></FieldRow>
        </div>}
        <div className="customer-detail-summary"><span>{detail.country || '—'}</span><span>{assignmentLabel(detail)}</span>{poolPreview && <span>{detail.contactCount} 位联系人</span>}<span>{detail.source}{detail.sourceDetail ? ` · ${detail.sourceDetail}` : ''}</span>{detail.ownerName && <span>负责用户：{detail.ownerName}</span>}{!poolPreview && <span>{stageLabel(detail.stage)}</span>}{!poolPreview && detail.stageNeedsReview && <span className="customer-review-tag">待核对</span>}</div>
        {!poolPreview && (detail.businessType || detail.developmentRestriction || detail.sourceCreatedAt) && <div className="customer-profile-fields">{detail.businessType && <span>业务类型：{detail.businessType}</span>}{detail.developmentRestriction && <span>开发限制：{detail.developmentRestriction}</span>}{detail.sourceCreatedAt && <span>来源创建日期：{detail.sourceCreatedAt}</span>}</div>}
        {!poolPreview && <section className="customer-detail-section customer-contact-section"><h2>联系人</h2><List size="small" locale={{ emptyText: '暂无联系人' }} dataSource={detail.contacts} renderItem={contact => <List.Item><List.Item.Meta title={<Space><span>{`${contact.name || '未填写姓名'}${contact.title ? ` · ${contact.title}` : ''}`}</span>{contact.touchStatus && <span className="customer-contact-touch">{CONTACT_TOUCH_LABELS[contact.touchStatus]}</span>}</Space>} description={<>{contact.email || '—'}{(contact.phone || contact.country) && <details><summary>其他联系方式</summary>{[contact.phone, contact.country].filter(Boolean).join(' · ')}</details>}</>} /></List.Item>} /></section>}
        {!poolPreview && <Opportunities key={`opportunities:${identityKey}:${detail.customerId}`} detail={detail} canCreate={canFollowup} selectedOpportunityId={selectedOpportunity?.opportunityId} onLocked={updateOpportunityLock} onChange={() => { void refresh(); if(selected.current)void openDetail(selected.current.customerId,true); }} onSelect={opportunity => { if(!lock.current) editFollowup(() => setSelectedOpportunity(opportunity)); }} />}
        {!poolPreview && <FollowupTasks opportunity={selectedOpportunity} key={`tasks:${identityKey}:${detail.customerId}`} detail={detail} canCreate={canFollowup} />}
        {!poolPreview && <section className="customer-detail-section customer-activity-section"><h2>动态</h2>{canFollowup && <div className="customer-followup">
          {selectedOpportunity && <Space size="small"><span>{selectedOpportunity.title}</span><Button type="text" size="small" disabled={followupLocked || opportunityLocked} onClick={() => editFollowup(() => setSelectedOpportunity(undefined))}>取消关联</Button></Space>}
          <div className="customer-followup-row customer-followup-when">
            <Select disabled={followupLocked} aria-label="联系方法" value={method} onChange={changeMethod} options={FOLLOWUP_METHODS.map(value => ({ value, label: FOLLOWUP_METHOD_LABELS[value] }))} />
            <Input disabled={followupLocked} aria-label="发生时间" type="datetime-local" value={occurredAt} onChange={event => editFollowup(() => setOccurredAt(event.target.value))} />
          </div>
          <div className="customer-followup-row customer-followup-target">
            <Select disabled={followupLocked} aria-label="跟进联系人" placeholder="公司级记录" allowClear value={currentContactId} onChange={changeContact} options={detail.contacts.map(contact => ({ value: contact.contactId, label: contact.name || contact.email || `联系人 ${contact.contactId}` }))} />
            <Select disabled={followupLocked || currentContactId === undefined || method === 'note'} aria-label="触达结果" placeholder="触达不变" allowClear value={contactStatus} onChange={value => editFollowup(() => setContactStatus(value))} options={CONTACT_TOUCH_STATUSES.map(value => ({ value, label: CONTACT_TOUCH_LABELS[value] }))} />
            <Select disabled={followupLocked} aria-label="跟进阶段" placeholder="阶段不变" allowClear value={stage} onChange={changeStage} options={BOARD_STAGES.map(value => ({ value, label: stageLabel(value) }))} />
          </div>
          <Input.TextArea disabled={followupLocked} aria-label="跟进记录" value={note} onChange={event => changeNote(event.target.value)} placeholder="填写跟进记录" rows={3} />
          <div className="customer-followup-actions"><Button type="primary" loading={busy} disabled={!note.trim()} onClick={() => void saveFollowup()}>保存跟进</Button></div>
        </div>}
        <List size="small" locale={{ emptyText: '暂无跟进记录' }} dataSource={detail.activities} renderItem={activity => {
          const occurrence = activity.occurredAt ?? activity.createdAt; const recording = activity.recordedAt ?? activity.createdAt;
          const historical = activity.method !== 'legacy' && !!activity.occurredAt && new Date(recording).getTime() - new Date(occurrence).getTime() > HISTORICAL_RECORD_THRESHOLD_MS;
          const contact = activity.contactName || (activity.contactId ? detail.contacts.find(item => item.contactId === activity.contactId)?.name || `联系人 ${activity.contactId}` : null);
          return <List.Item><List.Item.Meta title={<Space wrap><span>{FOLLOWUP_METHOD_LABELS[activity.method ?? 'legacy']}</span><span className="customer-activity-time">{new Date(occurrence).toLocaleString('zh-CN')}</span>{activity.actorName && <span>{activity.actorName}</span>}{contact && <span>{contact}</span>}{activity.opportunityTitle && <span>{activity.opportunityTitle}</span>}{activity.stage && <span>{stageLabel(activity.stage)}</span>}</Space>} description={<><div>{activity.note}</div>{historical && <div className="customer-activity-time">录入于 {new Date(recording).toLocaleString('zh-CN')}</div>}</>} /></List.Item>;
        }} /></section>}
        </div>
      </>}
    </DetailDrawer>
    <ImportDrawer key={identityKey} open={originalImportOpen} onClose={()=>setOriginalImportOpen(false)} port={originalImportPort}/>
    <Drawer rootClassName="app-drawer-below-titlebar" closable={false} rootStyle={{ ...tokenStyle, top: 'var(--app-titlebar-height)', height: 'calc(100% - var(--app-titlebar-height))' }} width={DRAWER_WIDTH} open={importOpen} title="导入客户" onClose={() => setImportOpen(false)} footer={preview ? <Button type="primary" loading={busy} onClick={() => void importFile()}>{pendingImports.current.length ? '重试未完成批次' : '导入'}</Button> : receipts.length ? <Button disabled={busy || correctionPending} onClick={() => { setImportOpen(false); setSearch(''); setStageFilter(undefined); changeTask(importKind === 'personal' ? 'personal' : 'operations'); }}>返回客户</Button> : undefined}>
      {error && <Alert type="error" showIcon message={error} className="mb-3" />}
      <Button disabled={busy} onClick={()=>void selectFile()}>选择文件</Button>
      <>
      {preview && <><div className="import-file-heading"><strong>{preview.fileName}</strong><span>{preparedRows.length} 行 · 需修正 {preparedRows.filter(row => row.issue).length} 行</span></div><div className="import-mapping">{IMPORT_FIELDS.map(field => <label key={field}>{FIELD_LABELS[field]}<Select aria-label={FIELD_LABELS[field]} allowClear disabled={busy || pendingImports.current.length > 0} value={mapping[field] || undefined} placeholder="未选择" options={preview.headers.map(header => ({ value: header, label: header }))} onChange={value => setMapping(previous => ({ ...previous, [field]: value ?? '' }))} /></label>)}</div><Table className="import-preview-table" size="small" tableLayout="fixed" scroll={{ x: 600 }} rowKey="index" dataSource={preparedRows} pagination={{ pageSize: PREVIEW_ROWS, showSizeChanger: false }} columns={[{ title: '原行', dataIndex: 'rowNumber', width: 60 }, { title: '公司 / 客户编号', width: 170, ellipsis: true, render: (_, row) => <div className="customer-name-cell"><strong>{row.companyName || '—'}</strong><span>{row.customerKey || '—'}</span></div> }, { title: '邮箱', dataIndex: 'email', width: 200, ellipsis: true }, { title: '校验', width: 170, render: (_, row) => row.issue || '可提交' }]} /></>}
      {correction && <section className="customer-detail-section"><h2>修正第 {correction.rowNumber} 行</h2><div className="import-mapping">{IMPORT_FIELDS.map(field => <label key={field}>{FIELD_LABELS[field]}<Input aria-label={`修正${FIELD_LABELS[field]}`} disabled={busy || correctionPending} value={correction.values[field] ?? ''} onChange={event => setCorrection(previous => previous ? { ...previous, values: { ...previous.values, [field]: event.target.value } } : null)} /></label>)}</div><Space><Button type="primary" loading={busy} onClick={() => void retryCorrection()}>{correctionPending ? '重试修正' : '重新导入'}</Button><Button disabled={busy || correctionPending} onClick={() => setCorrection(null)}>取消</Button></Space></section>}
      {receipts.map(receipt => <section key={receipt.batchId} className="customer-detail-section"><div className="customer-receipt-heading"><span>{receipt.published ? '已发布 · 导入回执' : '导入回执'}</span>{sharedScope(bootstrap) && can('leads.publish') && receipt.input?.kind === undefined && importKind === 'public' && !receipt.published && <Button loading={busy} disabled={!receipt.rows.some(row => row.status === 'created')} onClick={() => void publishReceipt(receipt)}>发布有效草稿</Button>}</div><div className="import-receipt-meta"><span>{receipt.input?.source}{receipt.fileName ? ` · ${receipt.fileName}` : ''}</span><details><summary>批次</summary>{receipt.batchId}</details></div><p className="import-receipt-counts">{Object.entries(RECEIPT_LABELS).map(([status, label]) => { const count = receipt.rows.filter(row => row.status === status).length; return count ? `${label} ${count}` : ''; }).filter(Boolean).join(' · ')}</p><Table className="import-receipt-table" size="small" tableLayout="fixed" scroll={{ x: 560 }} rowKey="rowId" dataSource={receipt.rows} pagination={{ pageSize: PREVIEW_ROWS, showSizeChanger: false }} columns={[{ title: '原行', render: (_, row) => receipt.rowNumbers?.[row.index] ?? receipt.offset + row.index + 1, width: 60 }, { title: '公司', width: 150, ellipsis: true, render: (_, row) => receipt.input?.rows[row.index]?.companyName || '—' }, { title: '结果', dataIndex: 'status', width: 80, render: value => RECEIPT_LABELS[value] ?? value }, { title: '说明', dataIndex: 'message', width: 140 }, { title: '', width: 130, render: (_, row) => row.status === 'invalid' && receipt.input ? receipts.some(item => item.correctsRowId === row.rowId) ? '已重新导入' : <Button size="small" disabled={busy || correctionPending} onClick={() => repairRow(receipt, row.index)}>修正</Button> : row.customerId ? <Button size="small" disabled={busy} onClick={() => { setImportOpen(false); void openDetail(row.customerId!); }}>查看客户</Button> : null }]} /></section>)}

      </>
    </Drawer>
  </div>;
}
