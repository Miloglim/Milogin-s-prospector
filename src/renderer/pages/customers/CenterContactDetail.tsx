import { askAssistant } from '../../lib/ask-ai';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Input, Modal, Select, Space, Spin, Tabs, Tag, Timeline, Tooltip, message } from 'antd';
import { CloseOutlined, DeleteOutlined, EditOutlined, PartitionOutlined, SearchOutlined, ShareAltOutlined, UndoOutlined } from '@ant-design/icons';
import { ContactDetailLayout, InfoTab, CRM_STAGES, STATUS_META } from '../../components/ContactDetail';
import { DiamondLogo } from '../../components/DiamondLogo';
import { CompanyBackcheck, COMPANY_BACKCHECK_UI_ENABLED, type BackcheckReport } from '../../components/CompanyBackcheck';
import { ONLINE_CHANNELS, FOLLOWUP_METHODS, FOLLOWUP_METHOD_LABELS, CONTACT_TOUCH_STATUSES, CONTACT_TOUCH_LABELS, SALES_PERFORMANCE_LIMITS, type ContactDelete, type ContactDeleteReceipt, type CenterCompanyUpdate, type CenterContactRef, type CenterContactDetail as Detail, type ContactMonitorDetail as MonitorDetail, type CenterContactUpdate, type CenterContactFollowup, type ContactMailEvent, type FollowupMethod, type ContactTouchStatus, type CustomerStage, type ContactMailAnalysisCorrection, type ContactMailAnalysisQuery, type ContactMailAnalysisRecord, type ContactMailAnalysisView, type MailAnalysisQueueStatus, type MailPriority, type MailRelevance, type CustomerGrade, type CustomerGradeItem, type CustomerGradeOverrideClear, type CustomerGradeOverrideReceipt, type CustomerGradeOverrideSet, type CustomerGradePage } from '../../../shared/online-crm';
import { useIdentity } from '../../IdentityContext';
import { centerInvoke, displayCenterContact } from './centerContactPort';
import { ContactSharingModal } from './ContactSharing';
import { canEditContactField } from './contactRights';
import { projectContactMailHistory } from './contactMailTimeline';
import { ONLINE_LIMITS } from '../../../shared/online-crm';
import { LeadIngressConflictDrawer, type LeadIngressConflictTarget } from './LeadIngressConflictDrawer';

const CONTACT_DETAIL_EXIT_MS = 320;
const MAIL_ANALYSIS_HISTORY_LIMIT = 20;
const GRADE_WINDOW_DAYS = 90;
const GRADE_PAGE_SIZE = 1;
const MILLISECONDS_PER_DAY = 86_400_000;

const MAIL_RELEVANCE_LABELS: Record<MailRelevance, string> = {
  customer_business: '客户业务', internal: '内部邮件', notification: '通知', vendor: '供应商', spam: '垃圾邮件', unknown: '待判断',
};
const MAIL_PRIORITY_LABELS: Record<MailPriority, string> = { normal: '普通', important: '重要', urgent: '紧急' };
const MAIL_SOURCE_LABELS: Record<ContactMailAnalysisRecord['source'], string> = { rule: '规则', ai: 'AI', human: '人工确认' };
const MAIL_CLASSIFICATION_LABELS: Record<ContactMailAnalysisRecord['classification'], string> = {
  other: '其他', replied: '回复', autoreply: '自动回复', bounced: '退信',
};

const CUSTOMER_GRADE_REASONS: Record<string, string> = {
  won_opportunity: '已成交',
  three_valid_replies: '3 次有效客户回复',
  valid_reply: '有效客户回复',
  open_opportunity: '存在开放商机',
  insufficient_customer_signal: '业务信号不足',
};

type GradeMutation =
  | { action: 'set'; signature: string; payload: CustomerGradeOverrideSet }
  | { action: 'clear'; signature: string; payload: CustomerGradeOverrideClear };

function customerGradeReason(item: CustomerGradeItem): string {
  const derivation = item.reasons.map(reason => CUSTOMER_GRADE_REASONS[reason] ?? reason).join(' · ');
  return item.source === 'manual' && item.override?.reason ? `人工：${item.override.reason}；规则：${derivation}` : derivation;
}

export function CustomerGradePanel({ customerId, readOnly = false, compact = false }: {
  customerId: string;
  readOnly?: boolean;
  compact?: boolean;
}) {
  const { identity, baseUrl, status } = useIdentity();
  const [mode, setMode] = useState<'set' | 'clear' | null>(null);
  const [grade, setGrade] = useState<CustomerGrade>('C');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const retry = useRef<GradeMutation | null>(null);
  const windowStart = useMemo(() => new Date(Date.now() - GRADE_WINDOW_DAYS * MILLISECONDS_PER_DAY).toISOString(), []);
  const windowEnd = useMemo(() => new Date().toISOString(), []);
  const query = useQuery({
    queryKey: ['customer-grade', baseUrl, identity?.userId, customerId],
    enabled: !!identity && !!customerId && status !== 'offline',
    queryFn: () => centerInvoke<CustomerGradePage>(ONLINE_CHANNELS.SALES_PERFORMANCE_GRADES, { from: windowStart, to: windowEnd, customerId, limit: GRADE_PAGE_SIZE, offset: 0 }),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  useEffect(() => {
    setMode(null);
    setReason('');
    retry.current = null;
  }, [customerId, identity?.userId]);

  const page = query.data?.ok ? query.data.data : undefined;
  const item = Array.isArray(page?.items) ? page.items[0] : undefined;
  const effectiveGrade = item?.effectiveGrade ?? null;
  const error = query.data && !query.data.ok ? query.data.error?.message ?? '客户分级读取失败' : query.error?.message;
  const canOverride = !readOnly && !!page && page.scope !== 'self';

  const begin = (next: 'set' | 'clear') => {
    setGrade(item?.effectiveGrade ?? 'C');
    setReason('');
    setMode(next);
  };

  const submit = async () => {
    if (!item || busy || !mode || !reason.trim()) return;
    const expectedVersion = item.override?.version ?? 0;
    const signature = JSON.stringify({ customerId, mode, expectedVersion, grade, reason: reason.trim() });
    if (retry.current?.signature !== signature) {
      retry.current = mode === 'clear'
        ? { action: 'clear', signature, payload: { customerId, expectedVersion, reason: reason.trim(), idempotencyKey: crypto.randomUUID() } }
        : { action: 'set', signature, payload: { customerId, expectedVersion, grade, reason: reason.trim(), idempotencyKey: crypto.randomUUID() } };
    }
    setBusy(true);
    try {
      const pending = retry.current;
      const result = pending.action === 'clear'
        ? await centerInvoke<CustomerGradeOverrideReceipt>(ONLINE_CHANNELS.SALES_PERFORMANCE_GRADE_CLEAR, pending.payload)
        : await centerInvoke<CustomerGradeOverrideReceipt>(ONLINE_CHANNELS.SALES_PERFORMANCE_GRADE_SET, pending.payload);
      if (result.ok) {
        retry.current = null;
        setMode(null);
        setReason('');
        message.success(pending.action === 'clear' ? '已恢复自动分级' : '客户等级已更新');
        await query.refetch();
      } else {
        if (result.error.code === 'CONFLICT') retry.current = null;
        message.error(result.error.message);
        void query.refetch();
      }
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : '结果未知，请用同一原因重试');
    } finally {
      setBusy(false);
    }
  };

  return <section className={`customer-grade-panel${compact ? ' is-compact' : ''}`} aria-label="客户分级">
    <header>
      <span>客户分级</span>
      {effectiveGrade ? <strong className={`customer-grade-mark is-${effectiveGrade.toLowerCase()}`}>{effectiveGrade}</strong> : <strong className="customer-grade-mark">—</strong>}
      {item?.source === 'manual' && <Tag>人工</Tag>}
      {item && <small>{item.source === 'manual' ? `自动规则为 ${item.computedGrade}` : '自动规则'}</small>}
    </header>
    {query.isFetching && !item && <div className="customer-grade-state"><Spin size="small" /></div>}
    {!query.isFetching && !item && !error && <div className="customer-grade-state">{status === 'offline' ? '联网后读取客户分级' : '暂无可分级信号'}</div>}
    {error && <Alert type="error" message={error} />}
    {effectiveGrade && item && <>
      <div className="customer-grade-reason"><span>{customerGradeReason(item)}</span><small>有效回复 {item.signals.validReplyCount} · 成交 {item.signals.wonOpportunityCount} · 开放商机 {item.signals.openOpportunityCount}</small></div>
      {canOverride && mode === null && <div className="customer-grade-actions">
        <Button size="small" icon={<EditOutlined />} onClick={() => begin('set')}>调整等级</Button>
        {item.override && <Button size="small" icon={<UndoOutlined />} onClick={() => begin('clear')}>清除人工</Button>}
      </div>}
      {canOverride && mode !== null && <div className="customer-grade-form">
        {mode === 'set' && <Select size="small" aria-label="客户等级" value={grade} onChange={value => setGrade(value as CustomerGrade)} options={[{ value: 'A', label: 'A 级' }, { value: 'B', label: 'B 级' }, { value: 'C', label: 'C 级' }]} />}
        <Input size="small" aria-label="等级调整原因" maxLength={SALES_PERFORMANCE_LIMITS.reason} value={reason} placeholder="填写调整原因" onChange={event => setReason(event.target.value)} />
        <Button size="small" type="primary" loading={busy} disabled={!reason.trim()} onClick={() => void submit()}>{mode === 'clear' ? '确认清除' : '保存等级'}</Button>
        <Button size="small" disabled={busy} onClick={() => { setMode(null); setReason(''); }}>取消</Button>
      </div>}
      {item.override && <div className="customer-grade-override-meta">{item.override.actorName || '管理角色'} · {new Date(item.override.updatedAt).toLocaleDateString('zh-CN')} · v{item.override.version}</div>}
    </>}
  </section>;
}

export function mailAnalysisListIndicator(view: ContactMailAnalysisView): string {
  const current = view.current;
  const task = current.relevance === 'customer_business' && current.requiresAction && view.taskSuggestion ? '待处理 · ' : '';
  const neutral = current.relevance === 'customer_business' ? '' : `${MAIL_RELEVANCE_LABELS[current.relevance]} · `;
  const summary = current.summary.trim() || MAIL_RELEVANCE_LABELS[current.relevance];
  return `${task}${neutral}${summary}`;
}

interface MailAnalysisDraft {
  classification: ContactMailAnalysisRecord['classification'];
  relevance: MailRelevance;
  summary: string;
  requiresAction: boolean;
  nextAction: string;
  priority: MailPriority;
  dueHint: string;
}

function draftForAnalysis(current: ContactMailAnalysisRecord): MailAnalysisDraft {
  return {
    classification: current.classification,
    relevance: current.relevance,
    summary: current.summary,
    requiresAction: current.relevance === 'customer_business' && current.requiresAction,
    nextAction: current.nextAction ?? '',
    priority: current.priority,
    dueHint: current.dueHint ?? '',
  };
}

function historyMarker(record: ContactMailAnalysisRecord, current: ContactMailAnalysisRecord): string {
  if (record.inputSequence < current.inputSequence) return '旧版本';
  if (Date.parse(record.createdAt) > Date.parse(current.createdAt)) return '晚到';
  return '历史';
}

export function MailAnalysisPanel({ queryInput, readOnly = false, onCurrent }: {
  queryInput: ContactMailAnalysisQuery | null;
  readOnly?: boolean;
  onCurrent?: (view: ContactMailAnalysisView) => void;
}) {
  const { identity, baseUrl } = useIdentity();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<MailAnalysisDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const retry = useRef<{ signature: string; key: string } | null>(null);
  const emitCurrent = useRef(onCurrent);
  emitCurrent.current = onCurrent;
  const key = ['contact-mail-analysis', baseUrl, identity?.userId, queryInput?.contactId, queryInput?.customerId, queryInput?.mailboxKey, queryInput?.messageKey, queryInput?.contentHash];
  const query = useQuery({
    queryKey: key,
    enabled: !!identity && !!queryInput,
    queryFn: () => centerInvoke<ContactMailAnalysisView>(ONLINE_CHANNELS.CONTACT_MAIL_ANALYSIS, queryInput!),
    refetchOnWindowFocus: true,
  });
  const queue = useQuery({
    queryKey: ['contact-mail-analysis-queue', baseUrl, identity?.userId],
    enabled: !!identity && !!queryInput,
    queryFn: () => centerInvoke<MailAnalysisQueueStatus>(ONLINE_CHANNELS.CONTACT_MAIL_ANALYSIS_QUEUE, undefined),
    refetchOnWindowFocus: true,
  });
  const view = query.data?.ok ? query.data.data : undefined;
  const analysis = view?.current;
  const error = query.data && !query.data.ok ? query.data.error.message : query.error?.message;
  const queueStatus = queue.data?.ok ? queue.data.data : undefined;
  useEffect(() => {
    if (!analysis) { setEditing(false); setDraft(null); return; }
    setDraft(draftForAnalysis(analysis));
    retry.current = null;
    setEditing(false);
  }, [analysis?.analysisId]);
  useEffect(() => { if (view) emitCurrent.current?.(view); }, [view]);

  async function saveCorrection() {
    if (!queryInput || !analysis || !draft || readOnly || !view?.canCorrect || view.access !== 'normal') return;
    const actionable = draft.relevance === 'customer_business' && draft.requiresAction;
    const payload: ContactMailAnalysisCorrection = {
      contactId: queryInput.contactId,
      customerId: queryInput.customerId,
      mailboxKey: queryInput.mailboxKey,
      messageKey: queryInput.messageKey,
      contentHash: queryInput.contentHash,
      idempotencyKey: '',
      expectedCurrentId: analysis.analysisId,
      classification: draft.classification,
      relevance: draft.relevance,
      summary: draft.summary.trim(),
      signals: analysis.signals,
      requiresAction: actionable,
      nextAction: actionable && draft.nextAction.trim() ? draft.nextAction.trim() : null,
      priority: actionable ? draft.priority : 'normal',
      dueHint: actionable && draft.dueHint.trim() ? draft.dueHint.trim() : null,
      confidence: 1,
      evidence: analysis.evidence,
    };
    const signature = JSON.stringify({ ...payload, idempotencyKey: undefined });
    if (retry.current?.signature !== signature) retry.current = { signature, key: crypto.randomUUID() };
    payload.idempotencyKey = retry.current.key;
    setSaving(true);
    try {
      const result = await centerInvoke<ContactMailAnalysisRecord>(ONLINE_CHANNELS.CONTACT_MAIL_ANALYSIS_CORRECT, payload);
      if (result.ok) {
        retry.current = null;
        setEditing(false);
        message.success('分析已更新');
        await query.refetch();
        return;
      }
      if (result.error.code !== 'UNAVAILABLE') {
        retry.current = null;
        if (result.error.code === 'CONFLICT') await query.refetch();
      }
      message.error(result.error.message || '分析更新失败');
    } catch {
      message.error('分析更新未确认，请重试');
    } finally {
      setSaving(false);
    }
  }

  if (!queryInput) return null;
  const canCorrect = !!view && view.access === 'normal' && view.canCorrect && !readOnly;
  const actionable = draft?.relevance === 'customer_business';
  const task = view && analysis?.relevance === 'customer_business' && analysis.requiresAction ? view.taskSuggestion : null;
  const pending = (queueStatus?.pending ?? 0) + (queueStatus?.retrying ?? 0) + (queueStatus?.running ?? 0);
  return <section className="mail-analysis-panel" data-readonly={readOnly ? 'true' : 'false'} aria-label="邮件分析">
    <style>{`
      .mail-analysis-panel{display:grid;gap:8px;min-width:0;overflow-x:hidden;max-height:min(42vh,320px);overflow-y:auto;padding:10px 0;border-top:1px solid var(--workspace-line,#edf0f2);font-size:11px;color:var(--workspace-text,#27313b)}
      .mail-analysis-block{display:grid;gap:6px;min-width:0;overflow-x:hidden}.mail-analysis-event-picker{width:100%;max-width:100%}
      .mail-analysis-head,.mail-analysis-actions,.mail-analysis-meta,.mail-analysis-signals{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
      .mail-analysis-head{justify-content:space-between}.mail-analysis-summary{margin:0;overflow-wrap:anywhere;line-height:1.55}
      .mail-analysis-meta{color:var(--workspace-muted,#7b858f);font-size:10px}.mail-analysis-chip{display:inline-flex;align-items:center;max-width:100%;min-height:20px;padding:0 7px;border:1px solid var(--workspace-line,#e5e8eb);border-radius:999px;background:var(--workspace-control,#f7f8fa);color:var(--workspace-muted,#66717d);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .mail-analysis-chip.is-task{border-color:#f3c56b;background:#fff8e8;color:#8a5800}.mail-analysis-chip.is-human{border-color:#8fd7c7;background:#effbf7;color:#176b5b}
      .mail-analysis-form{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;min-width:0;padding-top:4px}.mail-analysis-form label{display:grid;gap:3px;min-width:0;color:var(--workspace-muted,#7b858f);font-size:10px}.mail-analysis-form .is-wide{grid-column:1/-1}
      .mail-analysis-form .ant-select,.mail-analysis-form .ant-input{width:100%;min-width:0}.mail-analysis-history{display:grid;gap:5px;max-height:120px;overflow-y:auto;padding-top:6px;border-top:1px solid var(--workspace-line,#edf0f2)}
      .mail-analysis-history-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:6px;align-items:center;min-width:0;color:var(--workspace-muted,#7b858f);font-size:10px}.mail-analysis-history-row span:nth-child(2){overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .mail-analysis-error{color:#b42318}.mail-analysis-empty{color:var(--workspace-muted,#8a939c)}
      @media(max-width:824px){.mail-analysis-form{grid-template-columns:1fr}.mail-analysis-head{align-items:flex-start}.mail-analysis-panel{min-width:0;overflow-x:hidden}}
    `}</style>
    {query.isFetching && !analysis && <span className="mail-analysis-empty">分析加载中</span>}
    {error && <span className="mail-analysis-error">{error}</span>}
    {analysis && <>
      <div className="mail-analysis-head">
        <div className="mail-analysis-meta">
          <span className={`mail-analysis-chip${analysis.source === 'human' ? ' is-human' : ''}`}>{MAIL_SOURCE_LABELS[analysis.source]}</span>
          <span>{MAIL_RELEVANCE_LABELS[analysis.relevance]}</span>
          <span>{MAIL_CLASSIFICATION_LABELS[analysis.classification]}</span>
          <span>{Math.round(analysis.confidence * 100)}%</span>
        </div>
        <div className="mail-analysis-actions">
          {task && <span className="mail-analysis-chip is-task">待处理 · {MAIL_PRIORITY_LABELS[task.priority]}</span>}
          {canCorrect && <Button size="small" type="text" onClick={() => setEditing(value => !value)}>{editing ? '收起' : '修正'}</Button>}
        </div>
      </div>
      <p className="mail-analysis-summary">{analysis.summary}</p>
      {!!analysis.signals.length && <div className="mail-analysis-signals">{analysis.signals.map(signal => <span className="mail-analysis-chip" key={`${signal.code}:${signal.evidence}`} title={signal.evidence}>{signal.label}</span>)}</div>}
      {analysis.requiresAction && analysis.relevance === 'customer_business' && <div className="mail-analysis-meta"><span>{MAIL_PRIORITY_LABELS[analysis.priority]}</span>{analysis.nextAction && <span>{analysis.nextAction}</span>}{analysis.dueHint && <span>{analysis.dueHint}</span>}</div>}
      {(pending > 0 || (queueStatus?.failed ?? 0) > 0) && <div className="mail-analysis-meta">{pending > 0 && <span>分析中 {pending}</span>}{(queueStatus?.failed ?? 0) > 0 && <span>失败 {queueStatus!.failed}</span>}</div>}
      {editing && canCorrect && draft && <div className="mail-analysis-form">
        <label>分类<Select size="small" value={draft.classification} onChange={classification => setDraft(value => value && ({ ...value, classification }))} options={Object.entries(MAIL_CLASSIFICATION_LABELS).map(([value, label]) => ({ value, label }))} /></label>
        <label>相关性<Select size="small" value={draft.relevance} onChange={relevance => setDraft(value => value && ({ ...value, relevance, ...(relevance === 'customer_business' ? {} : { requiresAction: false, nextAction: '', priority: 'normal', dueHint: '' }) }))} options={Object.entries(MAIL_RELEVANCE_LABELS).map(([value, label]) => ({ value, label }))} /></label>
        <label>处理<Select size="small" value={draft.requiresAction ? 'yes' : 'no'} disabled={!actionable} onChange={value => setDraft(current => current && ({ ...current, requiresAction: value === 'yes' }))} options={[{ value: 'no', label: '无需处理' }, { value: 'yes', label: '需要处理' }]} /></label>
        <label className="is-wide">摘要<Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} value={draft.summary} maxLength={2000} onChange={event => setDraft(value => value && ({ ...value, summary: event.target.value }))} /></label>
        <label>优先级<Select size="small" value={draft.priority} disabled={!actionable} onChange={priority => setDraft(value => value && ({ ...value, priority }))} options={Object.entries(MAIL_PRIORITY_LABELS).map(([value, label]) => ({ value, label }))} /></label>
        <label className="is-wide">下一步<Input value={draft.nextAction} disabled={!actionable} maxLength={500} onChange={event => setDraft(value => value && ({ ...value, nextAction: event.target.value }))} /></label>
        <label className="is-wide">时间提示<Input value={draft.dueHint} disabled={!actionable} maxLength={120} onChange={event => setDraft(value => value && ({ ...value, dueHint: event.target.value }))} /></label>
        <div className="mail-analysis-actions is-wide"><Button size="small" type="primary" loading={saving} disabled={!draft.summary.trim()} onClick={saveCorrection}>保存修正</Button></div>
      </div>}
      {!!view?.history.length && <div className="mail-analysis-history">{view.history.slice(0, MAIL_ANALYSIS_HISTORY_LIMIT).map(record => <div className="mail-analysis-history-row" key={record.analysisId}><span>{MAIL_SOURCE_LABELS[record.source]}</span><span title={record.summary}>{record.summary}</span><span>{historyMarker(record, analysis)}</span></div>)}</div>}
    </>}
  </section>;
}

function analysisQueryForMail(event: ContactMailEvent | undefined): ContactMailAnalysisQuery | null {
  if (!event?.contentHash || !event.mailboxKey || !event.messageKey) return null;
  return {
    contactId: event.contactId,
    customerId: event.customerId,
    mailboxKey: event.mailboxKey,
    messageKey: event.messageKey,
    contentHash: event.contentHash,
    includeHistory: true,
    historyLimit: MAIL_ANALYSIS_HISTORY_LIMIT,
  };
}

function MailAnalysisEventPicker({ events, value, onChange }: {
  events: ContactMailEvent[];
  value: string | null;
  onChange: (eventId: string) => void;
}) {
  if (events.length < 2) return null;
  return <Select
    size="small"
    className="mail-analysis-event-picker"
    value={value ?? undefined}
    onChange={onChange}
    options={events.map(event => ({
      value: event.eventId,
      label: `${new Date(event.occurredAt).toLocaleDateString('zh-CN')} · ${event.subject || '无主题'}`,
    }))}
  />;
}

function CenterContactDetailContent({ reference, open, onClose, variant = 'drawer' }: { reference: CenterContactRef; open: boolean; onClose: () => void; variant?: 'drawer' | 'board' }) {
  const { identity, baseUrl, status } = useIdentity();
  const qc = useQueryClient();
  const current = useRef(true);
  useEffect(() => { current.current = true; return () => { current.current = false; }; }, []);
  const permissionScope = JSON.stringify([identity?.crmRoles?.slice().sort(), identity?.crmCapabilities?.slice().sort(), identity?.identityAdmin, identity?.mustChangePassword]);
  const backcheckScope = JSON.stringify([baseUrl, identity?.userId, permissionScope, reference?.customerId, reference?.contactId]);
  const currentBackcheckScope = useRef(backcheckScope); currentBackcheckScope.current = backcheckScope;
  const [transientReport, setTransientReport] = useState<{scope:string;report:BackcheckReport}>();
  const [sharing, setSharing] = useState(false);
  const [tab, setTab] = useState('info');
  const [note, setNote] = useState('');
  const [method, setMethod] = useState<FollowupMethod>('note');
  const [contactStatus, setContactStatus] = useState<ContactTouchStatus>();
  const [stage, setStage] = useState<CustomerStage>();
  const [busy, setBusy] = useState(false);
  const [ingressConflict, setIngressConflict] = useState<LeadIngressConflictTarget | null>(null);
  const deleteRetry = useRef<ContactDelete | null>(null);
  const updateRetry = useRef<{ signature: string; payload: CenterContactUpdate } | null>(null);
  const followupRetry = useRef<{ signature: string; payload: CenterContactFollowup } | null>(null);
  const key = ['center-contact-detail', baseUrl, identity?.userId, reference?.customerId, reference?.contactId, permissionScope];
  const query = useQuery({ queryKey: key, enabled: !!reference && !!identity, queryFn: () => centerInvoke<Detail>(ONLINE_CHANNELS.CONTACT_DETAIL, reference), refetchInterval: ONLINE_LIMITS.pollMs });
  useEffect(() => { updateRetry.current = null; followupRetry.current = null; deleteRetry.current = null; setBusy(false); setNote(''); setSharing(false); }, [backcheckScope]);
  const denied = query.data && !query.data.ok && ['FORBIDDEN', 'NOT_FOUND', 'UNAUTHORIZED', 'PASSWORD_CHANGE_REQUIRED'].includes(query.data.error.code);
  const authorizedDetail = useRef<{ scope: string; detail: Detail }>();
  if (denied || authorizedDetail.current?.scope !== backcheckScope) authorizedDetail.current = undefined;
  if (query.data?.ok) authorizedDetail.current = { scope: backcheckScope, detail: query.data.data };
  // An unavailable read must not unmount the existing inline editor and destroy its draft.
  const detail = authorizedDetail.current?.detail;
  const access = JSON.stringify([backcheckScope, !!detail, detail?.permissions, detail?.canEdit, detail?.canFollowup, detail?.canDelete, detail?.company.canEdit]);
  const latestAccess = useRef({ signature: access, generation: 0 });
  if (latestAccess.current.signature !== access) latestAccess.current = { signature: access, generation: latestAccess.current.generation + 1 };
  const accessGeneration = latestAccess.current.generation;
  const hasCurrentAccess = () => current.current && currentBackcheckScope.current === backcheckScope && latestAccess.current.generation === accessGeneration;
  useEffect(() => { setBusy(false); }, [accessGeneration]);
  useEffect(() => {
    if (!denied) return;
    setNote(''); setSharing(false); setTransientReport(undefined);
    for (const prefix of ['center-contacts', 'center-companies', 'center-company-detail', 'center-assignment', 'center-shares', 'inbox', 'dashboard', 'search']) void qc.invalidateQueries({ queryKey: [prefix] });
    onClose();
  }, [denied, backcheckScope, qc]);
  const canEditField = (field: string) => !!detail && (detail.permissions ? canEditContactField(detail.permissions, field) : field === 'relationshipStage' ? detail.canFollowup : detail.canEdit);
  const error = query.data && !query.data.ok ? query.data.error.message : query.error?.message;
  const changed = (next: Detail) => { qc.setQueryData(key, { ok: true, data: next }); void qc.invalidateQueries({ queryKey: ['center-contacts'] }); void qc.invalidateQueries({ queryKey: ['center-assignment'] }); void qc.invalidateQueries({ queryKey: ['contacts', 'match'] }); void qc.invalidateQueries({ queryKey: ['inbox'] }); void qc.invalidateQueries({ queryKey: ['dashboard'] }); void qc.invalidateQueries({ queryKey: ['search'] }); void qc.invalidateQueries({ queryKey: ['center-company-detail'] }); };
  function remove() {
    if(!hasCurrentAccess()||!reference||!detail?.canDelete||busy||status==='offline')return;
    const captured=reference;
    const startedScope=backcheckScope;
    Modal.confirm({title:'删除该联系人？',content:'删除后不再参与匹配和新发送任务，历史记录保留。',okText:'删除',okType:'danger',cancelText:'取消',onOk:async()=>{
      if(!hasCurrentAccess()||!current.current||currentBackcheckScope.current!==startedScope)return;
      setBusy(true);
      try {
        const previous=deleteRetry.current?.contacts[0];
        if(!previous||previous.contactId!==captured.contactId||previous.customerId!==captured.customerId)deleteRetry.current={contacts:[{...captured,expectedVersion:detail.contact.contactVersion??detail.contact.customerVersion}],idempotencyKey:crypto.randomUUID()};
        const r=await centerInvoke<ContactDeleteReceipt>(ONLINE_CHANNELS.CONTACT_DELETE,deleteRetry.current);
        if(!hasCurrentAccess()||!current.current||currentBackcheckScope.current!==startedScope)return;
        if(!r.ok){if(r.error.code==='CONFLICT')deleteRetry.current=null;message.error(r.error.message);void qc.invalidateQueries({queryKey:key});return;}
        for(const prefix of ['center-contacts','center-companies','center-company-detail','center-contact-detail','dashboard','search','center-assignment','inbox'])void qc.invalidateQueries({queryKey:[prefix]});
        message.success('已删除');onClose();
      }finally{if(current.current&&currentBackcheckScope.current===startedScope)setBusy(false);}
    }});
  }
  async function save(field: string, value: string | null) {
    if (!hasCurrentAccess() || !reference || !detail || !canEditField(field) || busy) return false;
    const startedScope = backcheckScope;
    const isCurrent = () => hasCurrentAccess() && currentBackcheckScope.current === startedScope;
    if (detail.permissions && field === 'status' && ![null, '', 'reached', 'replied', 'bounced', 'autoreply'].includes(value)) return;
    if (field === 'relationshipStage' || field === 'status' && [null, '', 'reached', 'replied', 'bounced', 'autoreply'].includes(value)) {
      if (field === 'relationshipStage' ? !(detail.permissions?.canChangeStage ?? detail.canFollowup) : !detail.canFollowup) return;
      const nextStage = CRM_STAGES.find(item => item.key === value);
      if (field === 'relationshipStage' && !nextStage) return;
      const content = field === 'relationshipStage'
        ? { note: `跟进阶段：${nextStage!.label}`, method: 'note' as const, stage: nextStage!.key as CustomerStage }
        : {
            note: `联系状态：${value ? STATUS_META[value]?.label ?? value : '未触达'}`,
            method: 'other' as const,
            contactStatus: (value === 'reached' ? 'contacted' : value || 'uncontacted') as ContactTouchStatus,
          };
      const signature = JSON.stringify({ reference, content });
      if (followupRetry.current?.signature !== signature) followupRetry.current = { signature, payload: { ...reference, ...content, expectedVersion: detail.contact.contactVersion ?? detail.contact.customerVersion, idempotencyKey: crypto.randomUUID() } };
      setBusy(true);
      try {
        const result = await centerInvoke<Detail>(ONLINE_CHANNELS.CONTACT_FOLLOWUP, followupRetry.current.payload);
        if (!isCurrent()) return false;
        if (result.ok) { followupRetry.current = null; changed(result.data); return true; }
        else { if (result.error.code === 'CONFLICT') followupRetry.current = null; message.error(result.error.message); void query.refetch(); return false; }
      } catch (error) { if (isCurrent()) message.error(error instanceof Error ? error.message : '保存失败'); return false; }
      finally { if (isCurrent()) setBusy(false); }
    }
    const normalized = field === 'tags' ? value ? JSON.parse(value) : [] : field === 'stage' ? value ?? 'cold' : field === 'status' ? value ?? '' : value;
    const fields = { [field]: normalized } as CenterContactUpdate['fields'];
    const signature = JSON.stringify({ reference, fields });
    if (updateRetry.current?.signature !== signature) updateRetry.current = { signature, payload: { ...reference, expectedVersion: detail.contact.contactVersion ?? detail.contact.customerVersion, idempotencyKey: crypto.randomUUID(), fields } };
    setBusy(true);
    try {
      const pending = updateRetry.current;
      if (!pending) return false;
      const result = await centerInvoke<Detail>(ONLINE_CHANNELS.CONTACT_UPDATE, pending.payload);
      if (!isCurrent()) return false;
      if (result.ok) { updateRetry.current = null; changed(result.data); return true; }
      if (result.error.code === 'CONFLICT' && result.error.message.includes('冲突编号')) {
        setIngressConflict({ source: 'api_contact_update', idempotencyKey: pending.payload.idempotencyKey, rowLabel: '修改联系人邮箱' });
      } else {
        message.error(result.error.message);
      }
      if (result.error.code === 'CONFLICT') updateRetry.current = null;
      void query.refetch();
      return false;
    }
    catch (error) { if (isCurrent()) message.error(error instanceof Error ? error.message : '保存失败'); return false; }
    finally { if (isCurrent()) setBusy(false); }
  }
  async function followup() {
    if (!hasCurrentAccess() || !reference || !detail?.canFollowup || busy || !note.trim()) return;
    const startedScope = backcheckScope;
    const isCurrent = () => hasCurrentAccess() && currentBackcheckScope.current === startedScope;
    const content = { note: note.trim(), method, ...(stage && (detail.permissions?.canChangeStage ?? true) ? { stage } : {}), ...(method !== 'note' && contactStatus ? { contactStatus } : {}) };
    const signature = JSON.stringify({ reference, content });
    if (followupRetry.current?.signature !== signature) followupRetry.current = { signature, payload: { ...reference, ...content, expectedVersion: detail.contact.contactVersion ?? detail.contact.customerVersion, idempotencyKey: crypto.randomUUID() } };
    setBusy(true);
    try { const result = await centerInvoke<Detail>(ONLINE_CHANNELS.CONTACT_FOLLOWUP, followupRetry.current.payload); if (!isCurrent()) return; if (result.ok) { followupRetry.current = null; changed(result.data); setNote(''); message.success('已保存'); } else { if (result.error.code === 'CONFLICT') followupRetry.current = null; message.error(result.error.message); void query.refetch(); } }
    catch (error) { if (isCurrent()) message.error(error instanceof Error ? error.message : '保存失败'); }
    finally { if (isCurrent()) setBusy(false); }
  }
  const companyRetry = useRef<CenterCompanyUpdate | null>(null);
  useEffect(() => { companyRetry.current = null; setTransientReport(undefined); }, [backcheckScope]);
  const canBackcheck = !!detail && (detail.company.canEdit || detail.permissions?.canSendMail || detail.canSendMail);
  const latestBackcheckAccess = useRef({canRun:canBackcheck,canWrite:!!detail?.company.canEdit}); latestBackcheckAccess.current = {canRun:canBackcheck,canWrite:!!detail?.company.canEdit};
  async function backcheck(input: {companyName:string;website?:string;country?:string}) {
    if (!hasCurrentAccess() || !reference || !detail || !canBackcheck || status === 'offline') return {success:false,error:'当前无法背调'};
    if (detail.company.canEdit && !detail.company.revision) return {success:false,error:'公司资料版本不可用'};
    const startedScope = backcheckScope;
    if (!detail.company.canEdit) companyRetry.current = null;
    if (!companyRetry.current) {
      const result = await window.api.invoke('ai:backcheck',{...input,centerReference:reference}) as {success:boolean;data?:{report:BackcheckReport};error?:string};
      if (!hasCurrentAccess() || !current.current || currentBackcheckScope.current !== startedScope || !latestBackcheckAccess.current.canRun) return {success:false,error:'账号或页面已切换'};
      if (!result.success || !result.data) return {success:false,error:result.error};
      if (!latestBackcheckAccess.current.canWrite) { setTransientReport({scope:startedScope,report:result.data.report}); return {success:true}; }
      companyRetry.current = {...reference,expectedRevision:detail.company.revision!,idempotencyKey:crypto.randomUUID(),fields:{backcheckData:result.data.report as unknown as NonNullable<CenterCompanyUpdate['fields']['backcheckData']>}};
    }
    const saved = await centerInvoke<Detail>(ONLINE_CHANNELS.COMPANY_UPDATE,companyRetry.current);
    if (!hasCurrentAccess() || !current.current || currentBackcheckScope.current !== startedScope || !latestBackcheckAccess.current.canRun) return {success:false,error:'账号或页面已切换'};
    if (!saved.ok) {
      if (saved.error.code === 'CONFLICT' && saved.error.message.includes('冲突编号')) {
        setIngressConflict({ source: 'api_contact_update', idempotencyKey: companyRetry.current.idempotencyKey, rowLabel: '修改公司资料' });
      }
      if (saved.error.code === 'CONFLICT') { companyRetry.current=null; void query.refetch(); }
      return {success:false,error:saved.error.message};
    }
    companyRetry.current=null; changed(saved.data); return {success:true};
  }
  const contact = detail ? displayCenterContact(detail.contact) : undefined;
  const reached = detail && ['contacted','replied','bounced','autoreply'].includes(detail.contact.touchStatus);
  const history = useMemo(() => {
    if (!detail) return [];
    const labels: Record<string, string> = { received: '收到邮件', sent: '已发送', replied: '已收到', autoreply: '自动回复', bounced: '退信', cc: '抄送' };
    const colors: Record<string, string> = { received: '#2563eb', sent: '#2563eb', replied: '#22a644', autoreply: '#ff9800', bounced: '#d93025', cc: '#0891b2' };
    const item = (key: string, time: string, color: string, label: string, title: string | null, preview: string | null) => ({
      key,
      color,
      children: <div className="text-[11px]">
        <div className="flex items-center gap-1.5">
          <span className="font-medium text-gray-700">{label}</span>
          <span className="text-gray-400">{new Date(time).toLocaleDateString('zh-CN')}</span>
        </div>
        {title && <div className="text-[11px] text-gray-600 mt-0.5">{title}</div>}
        {preview && <div className="text-[10px] text-gray-400 mt-0.5 line-clamp-2">{preview}</div>}
      </div>,
    });
    const mailEvents = detail.mailEvents || [];
    const projected = projectContactMailHistory(mailEvents);
    const mailActivities = projected.activityIds;
    const mailItems = projected.mail.map(event => ({ time: event.occurredAt, ...item(event.eventId, event.occurredAt, colors[event.kind] || '#8c8c8c', labels[event.kind] || event.kind, event.subject || '无主题', event.preview) }));
    const correctionLabels: Record<string, string> = { other: '其他', replied: '回复', autoreply: '自动回复', bounced: '退信' };
    const corrections = projected.corrections.map(event => ({ time: event.recordedAt, ...item(`classification:${event.eventId}`, event.recordedAt, '#8c8c8c', '邮件分类更正', `更正为${correctionLabels[event.correction!.classification]}`, null) }));
    const loadedEventIds = new Set(mailEvents.map(event => event.eventId));
    const activities = detail.activities.filter(activity => !mailActivities.has(activity.id) && !(activity.mailEventId && loadedEventIds.has(activity.mailEventId))).map(activity => {
      const time = activity.occurredAt ?? activity.createdAt;
      const label = activity.method && activity.method !== 'legacy' ? FOLLOWUP_METHOD_LABELS[activity.method] : '跟进';
      return { time, ...item(activity.id, time, '#8c8c8c', `${label}${activity.mailSuperseded ? ' · 历史记录（已更正）' : ''}`, activity.actorName || null, activity.note) };
    });
    return [...mailItems, ...corrections, ...activities].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
  }, [detail]);
  const analysisMailEvents = useMemo(() => projectContactMailHistory(detail?.mailEvents ?? []).mail, [detail]);
  const [analysisEventId, setAnalysisEventId] = useState<string | null>(null);
  useEffect(() => {
    if (!analysisMailEvents.length) { setAnalysisEventId(null); return; }
    setAnalysisEventId(current => current && analysisMailEvents.some(event => event.eventId === current) ? current : analysisMailEvents[0]!.eventId);
  }, [analysisMailEvents]);
  const analysisEvent = analysisMailEvents.find(event => event.eventId === analysisEventId) ?? analysisMailEvents[0];
  const analysisQuery = useMemo(() => analysisQueryForMail(analysisEvent), [analysisEvent]);
  return <ContactDetailLayout open={open} onClose={onClose} destroyOnClose {...(variant === 'board' ? { mask: true, rootClassName: 'customer-classic-floating-detail', width: 'clamp(360px, 44vw, 620px)', rootStyle: { top: 36 }, styles: { body: { padding: 12, height: '100%', overflow: 'hidden' } } } : {})}>
    <div className="flex-shrink-0 pb-3 mb-2 border-b border-gray-100"><div className="flex items-center gap-1.5 flex-wrap"><span className="text-base font-semibold text-gray-900">{contact ? [contact.firstName, contact.lastName].filter(Boolean).join(' ') || '未命名联系人' : '联系人'}</span><Tooltip title="在收件箱中搜索"><Button type="text" aria-label="在收件箱中搜索" size="small" icon={<SearchOutlined />} className="btn-hover-color" style={{ color: '#bbb', padding: 0, minWidth: 20, height: 20 }} disabled={!contact?.email} onClick={() => { window.location.hash = `#/inbox?search=${encodeURIComponent(contact?.email ?? '')}`; }} /></Tooltip><Tooltip title={reached ? '在CRM中查看' : '未进入CRM管线'}><Button type="text" aria-label="在CRM中查看" size="small" icon={<PartitionOutlined />} disabled={!reached} className="btn-hover-color" style={{ color: reached ? '#bbb' : '#d9d9d9', padding: 0, minWidth: 20, height: 20 }} onClick={() => { const target = new URLSearchParams({ view: 'board', centerContact: String(contact?.contactId ?? ''), centerCustomer: contact?.customerId ?? '' }); window.location.hash = '#/customers?' + target.toString(); onClose(); }} /></Tooltip><Tooltip title="带着这位联系人问 AI"><Button type="text" aria-label="带着这位联系人问 AI" size="small" disabled={!contact} onClick={() => { if (contact) askAssistant({ question: `请查询中心联系人 #${contact.contactId}（客户编号 ${contact.customerId}），分析最近情况与跟进建议。` }); }} icon={<DiamondLogo size={14} state="static" />} className="btn-hover-color" style={{ color: '#bbb', padding: 0, minWidth: 20, height: 20 }} /></Tooltip><Tooltip title="共享线索"><Button type="text" aria-label="共享线索" size="small" disabled={!detail?.permissions?.canShare || busy || status === 'offline'} onClick={() => setSharing(true)} icon={<ShareAltOutlined />} className="btn-hover-color" style={{ color: '#bbb', padding: 0, minWidth: 20, height: 20 }} /></Tooltip><Tooltip title="删除"><Button type="text" aria-label="删除联系人" size="small" disabled={!detail?.canDelete || busy || status === 'offline'} onClick={remove} icon={<DeleteOutlined />} className="btn-hover-color" style={{ padding: 0, minWidth: 20, height: 20 }} /></Tooltip><Button type="text" size="small" icon={<CloseOutlined />} onClick={onClose} className="ml-auto" /></div><div className="text-[11px] text-gray-500 font-mono mt-1">{contact?.email}</div></div>
    {query.isFetching && !detail && <Spin />}{error && <Alert type="error" message={error} />}
    {contact && detail && <Tabs activeKey={tab} onChange={setTab} size="small" className="contact-detail-tabs" items={[
      { key: 'info', label: '基本信息', children: <div className="customer-info-with-grade"><CustomerGradePanel customerId={reference.customerId} /><InfoTab key={backcheckScope} contact={contact} canEdit={(detail.permissions ? !!(detail.permissions.editableFields.length || detail.permissions.canFollowup || detail.permissions.canChangeStage) : detail.canEdit)} canEditField={canEditField} onSaveField={save} /></div> },
      { key: 'company', label: '公司背调', children: detail.supplementAvailable === false ? <div className="text-xs text-gray-400">联网后加载公司资料</div> : <CompanyBackcheck companyId={null} run={canBackcheck && status !== 'offline' ? backcheck : undefined} centerCompany={{ id: detail.company.companyId, name: detail.company.name, domain: detail.company.domain, backcheckData: transientReport?.scope === backcheckScope ? JSON.stringify(transientReport.report) : detail.company.backcheckData ? JSON.stringify(detail.company.backcheckData) : null }} /> },
      { key: 'history', label: '往来记录', children: <div className="space-y-3">{(detail.supplementAvailable === false || !detail.mailAvailable) && <div className="text-xs text-gray-400">{detail.supplementAvailable === false ? '联网后加载往来记录' : '邮件往来暂未接入'}</div>}{analysisQuery && <div className="mail-analysis-block"><MailAnalysisEventPicker events={analysisMailEvents} value={analysisEventId} onChange={setAnalysisEventId} /><MailAnalysisPanel key={analysisEvent?.eventId} queryInput={analysisQuery} /></div>}{detail.canFollowup && <div className="space-y-2"><Space wrap><Select size="small" value={method} onChange={setMethod} options={FOLLOWUP_METHODS.map(value => ({ value, label: FOLLOWUP_METHOD_LABELS[value] }))} /><Select size="small" placeholder="联系状态" allowClear value={contactStatus} disabled={method === 'note'} onChange={setContactStatus} options={CONTACT_TOUCH_STATUSES.filter(value => value !== 'uncontacted').map(value => ({ value, label: CONTACT_TOUCH_LABELS[value] }))} /><Select size="small" placeholder="跟进阶段" disabled={detail.permissions ? !detail.permissions.canChangeStage : false} allowClear value={stage} onChange={setStage} options={CRM_STAGES.map(item => ({ value: item.key, label: item.label }))} /></Space><Input.TextArea rows={3} value={note} onChange={event => setNote(event.target.value)} placeholder="跟进记录" /><Button type="primary" size="small" block loading={busy} disabled={!note.trim()} onClick={followup}>保存</Button></div>}<div><div className="text-[11px] font-semibold text-gray-600 mb-2 flex items-center gap-2">互动历史<Tag className="text-[9px] px-1 my-0">{history.length} 条</Tag></div>{history.length ? <Timeline items={history.slice(0, 20)} /> : <div className="text-xs text-gray-400 p-3 bg-gray-50 rounded text-center">暂无互动记录</div>}</div></div> },
    ].filter(item => COMPANY_BACKCHECK_UI_ENABLED || item.key !== 'company')} />}
    {sharing && reference && detail && <ContactSharingModal key={`${baseUrl}:${identity?.userId}:${reference.contactId}`} reference={reference} detail={detail} close={() => setSharing(false)} />}
    {ingressConflict && <LeadIngressConflictDrawer
      target={ingressConflict}
      onClose={() => setIngressConflict(null)}
      onResolved={() => {
        updateRetry.current = null;
        companyRetry.current = null;
        setIngressConflict(null);
        message.success('冲突已处理');
        return query.refetch().then(() => undefined);
      }}
    />}
  </ContactDetailLayout>;
}

export function CenterContactDetail({ reference, onClose, variant = 'drawer' }: { reference: CenterContactRef | null; onClose: () => void; variant?: 'drawer' | 'board' }) {
  const [activeReference, setActiveReference] = useState<CenterContactRef | null>(reference);
  const [open, setOpen] = useState(!!reference);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (exitTimer.current) clearTimeout(exitTimer.current);
    if (reference) {
      setActiveReference(reference);
      setOpen(true);
      return;
    }
    setOpen(false);
    exitTimer.current = setTimeout(() => { setActiveReference(null); exitTimer.current = null; }, CONTACT_DETAIL_EXIT_MS);
    return () => { if (exitTimer.current) clearTimeout(exitTimer.current); };
  }, [reference?.customerId, reference?.contactId]);
  if (!activeReference) return null;
  return <CenterContactDetailContent reference={activeReference} open={open} onClose={onClose} variant={variant} />;
}

export function ContactMonitorDetail({ reference, onClose }: { reference: CenterContactRef | null; onClose: () => void }) {
  const { identity, baseUrl } = useIdentity();
  const scope = JSON.stringify([baseUrl, identity?.userId, reference?.customerId, reference?.contactId]);
  const query = useQuery({
    queryKey: ['center-contact-monitor', baseUrl, identity?.userId, reference?.customerId, reference?.contactId],
    enabled: !!reference && !!identity,
    queryFn: () => centerInvoke<MonitorDetail>(ONLINE_CHANNELS.CONTACT_MONITOR_DETAIL, reference),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const detail = query.data?.ok ? query.data.data : undefined;
  const error = query.data && !query.data.ok ? query.data.error.message : query.error?.message;
  const history = useMemo(() => {
    if (!detail) return [];
    const labels: Record<string, string> = { received: '收到邮件', sent: '已发送', replied: '已收到', autoreply: '自动回复', bounced: '退信', cc: '抄送' };
    const colors: Record<string, string> = { received: '#2563eb', sent: '#2563eb', replied: '#22a644', autoreply: '#ff9800', bounced: '#d93025', cc: '#0891b2' };
    const timelineItem = (key: string, time: string, color: string, label: string, title: string | null, preview: string | null, meta?: string) => ({
      key,
      time,
      color,
      children: <div className="text-[11px]">
        <div className="flex items-center gap-1.5"><span className="font-medium text-gray-700">{label}</span><span className="text-gray-400">{new Date(time).toLocaleString('zh-CN')}</span></div>
        {title && <div className="text-[11px] text-gray-600 mt-0.5">{title}</div>}
        {preview && <div className="text-[10px] text-gray-400 mt-0.5 line-clamp-2">{preview}</div>}
        {meta && <div className="contact-monitor-mail-meta">{meta}</div>}
      </div>,
    });
    const projected = projectContactMailHistory(detail.mailEvents);
    const mail = projected.mail.map(event => timelineItem(event.eventId, event.occurredAt, colors[event.kind] || '#8c8c8c', labels[event.kind] || event.kind, event.subject || '无主题', event.preview, [event.fromEmail, ...event.toEmails].filter(Boolean).join(' → ')));
    const loadedEventIds = new Set(detail.mailEvents.map(event => event.eventId));
    const activities = detail.activities.filter(activity => !projected.activityIds.has(activity.id) && !(activity.mailEventId && loadedEventIds.has(activity.mailEventId))).map(activity => {
      const time = activity.occurredAt ?? activity.createdAt;
      const method = activity.method && activity.method !== 'legacy' ? FOLLOWUP_METHOD_LABELS[activity.method] : '跟进';
      return timelineItem(activity.id, time, '#8c8c8c', method, activity.actorName || null, activity.note, activity.contactStatus ? CONTACT_TOUCH_LABELS[activity.contactStatus] : undefined);
    });
    return [...mail, ...activities].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()).map(({ time: _time, ...item }) => item);
  }, [detail]);
  const analysisMailEvents = useMemo(() => projectContactMailHistory(detail?.mailEvents ?? []).mail, [detail]);
  const [analysisEventId, setAnalysisEventId] = useState<string | null>(null);
  useEffect(() => {
    if (!analysisMailEvents.length) { setAnalysisEventId(null); return; }
    setAnalysisEventId(current => current && analysisMailEvents.some(event => event.eventId === current) ? current : analysisMailEvents[0]!.eventId);
  }, [analysisMailEvents]);
  const analysisEvent = analysisMailEvents.find(event => event.eventId === analysisEventId) ?? analysisMailEvents[0];
  const analysisQuery = useMemo(() => analysisQueryForMail(analysisEvent), [analysisEvent]);
  const contact = detail?.contact;
  const contactName = contact ? [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.email || '联系人' : '联系人';
  const gradeCustomerId = contact?.customerId ?? reference?.customerId;
  const stage = contact ? CRM_STAGES.find(item => item.key === contact.stage)?.label ?? contact.stage : '';
  return <ContactDetailLayout open={!!reference} onClose={onClose} destroyOnClose width="min(500px, calc(100vw - 16px))">
    <div className="contact-monitor-detail" data-scope={scope}>
      <div className="contact-monitor-detail-header">
        <div className="contact-monitor-detail-title"><strong>{contactName}</strong><span>{contact?.email}</span></div>
        <Tag>{contact?.touchStatus ? CONTACT_TOUCH_LABELS[contact.touchStatus] : '监督'}</Tag>
        <Button type="text" size="small" aria-label="关闭监督详情" icon={<CloseOutlined />} onClick={onClose} />
      </div>
      <div className="contact-monitor-detail-body">
        {query.isFetching && !detail && <Spin />}
        {error && <Alert type="error" message={error} />}
        {detail && <>
          {gradeCustomerId && <CustomerGradePanel customerId={gradeCustomerId} readOnly compact />}
          <dl className="contact-monitor-fields">
            <div className="contact-monitor-field"><dt>公司</dt><dd>{detail.company.name}</dd></div>
            <div className="contact-monitor-field"><dt>负责人</dt><dd>{contact?.ownerName || '-'}</dd></div>
            <div className="contact-monitor-field"><dt>职位</dt><dd>{contact?.title || '-'}</dd></div>
            <div className="contact-monitor-field"><dt>阶段</dt><dd>{stage || '-'}</dd></div>
            <div className="contact-monitor-field"><dt>电话</dt><dd>{contact?.phone || '-'}</dd></div>
            <div className="contact-monitor-field"><dt>WhatsApp</dt><dd>{contact?.whatsapp || '-'}</dd></div>
            <div className="contact-monitor-field"><dt>国家</dt><dd>{contact?.country || '-'}</dd></div>
            <div className="contact-monitor-field"><dt>来源</dt><dd>{contact?.sourceDetail || contact?.source || '-'}</dd></div>
            <div className="contact-monitor-field"><dt>访问时间</dt><dd>{new Date(detail.accessedAt).toLocaleString('zh-CN')}</dd></div>
          </dl>
          {analysisQuery && <div className="mail-analysis-block"><MailAnalysisEventPicker events={analysisMailEvents} value={analysisEventId} onChange={setAnalysisEventId} /><MailAnalysisPanel key={analysisEvent?.eventId} queryInput={analysisQuery} readOnly /></div>}
          <div className="contact-monitor-timeline">
            <div className="contact-monitor-timeline-title">互动历史 <Tag>{history.length} 条</Tag></div>
            {history.length ? <Timeline items={history.slice(0, detail.mailEventLimit)} /> : <div className="text-xs text-gray-400">暂无互动记录</div>}
          </div>
        </>}
      </div>
    </div>
  </ContactDetailLayout>;
}
