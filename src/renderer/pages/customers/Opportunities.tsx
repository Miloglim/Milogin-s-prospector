import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, Pagination, Space } from 'antd';
import { ONLINE_CHANNELS as CHANNEL, ONLINE_LIMITS, OPPORTUNITY_LIMITS, OPPORTUNITY_STAGES, OPPORTUNITY_STAGE_LABELS } from '../../../shared/online-crm';
import { useVisiblePolling } from '../../hooks/useVisiblePolling';
import type { LeadDetail, Opportunity, OpportunityCreate, OpportunityHistory, OpportunityPage, OpportunityStage, OpportunityUpdateStage, Result } from '../../../shared/online-crm';

const PREWRITE_ERRORS = ['INVALID_INPUT', 'FORBIDDEN', 'UNAUTHORIZED', 'NOT_FOUND', 'CONFLICT', 'PASSWORD_CHANGE_REQUIRED', 'PAYLOAD_TOO_LARGE'];
const ACCESS_ERRORS = ['FORBIDDEN', 'UNAUTHORIZED', 'NOT_FOUND', 'PASSWORD_CHANGE_REQUIRED'];
const CURRENCY_LENGTH = 3;
type Draft = { title: string; pol: string; pod: string; containerType: string; amount: string; currency: string; description: string; source: string };
type StageDraft = { row: Opportunity; stage: OpportunityStage; amount: string; currency: string; lostReason: string; evidence: string };
type PendingCommand = { channel: string; input: OpportunityCreate | OpportunityUpdateStage };
const EMPTY_DRAFT: Draft = { title: '', pol: '', pod: '', containerType: '', amount: '', currency: '', description: '', source: '' };

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function stage(value: unknown): value is OpportunityStage { return typeof value === 'string' && OPPORTUNITY_STAGES.includes(value as OpportunityStage); }
function nullableText(value: unknown): boolean { return value === null || typeof value === 'string'; }
function history(value: unknown): value is OpportunityHistory {
  return record(value) && typeof value.historyId === 'string' && (value.fromStage === null || stage(value.fromStage)) && stage(value.toStage)
    && typeof value.actorId === 'string' && nullableText(value.actorName) && typeof value.occurredAt === 'string'
    && ['amount', 'currency', 'lostReason', 'evidence'].every(key => nullableText(value[key]));
}
function opportunity(value: unknown, customerId: string): value is Opportunity {
  return record(value) && typeof value.opportunityId === 'string' && value.opportunityId.length > 0 && value.customerId === customerId
    && typeof value.title === 'string' && typeof value.description === 'string' && typeof value.source === 'string' && stage(value.stage)
    && typeof value.canManage === 'boolean' && Number.isSafeInteger(value.version) && Number(value.version) > 0
    && ['pol', 'pod', 'containerType', 'amount', 'currency', 'lostReason', 'evidence', 'ownerName', 'closedAt', 'closedBy'].every(key => nullableText(value[key]))
    && ['ownerUserId', 'createdBy', 'createdAt', 'updatedAt'].every(key => typeof value[key] === 'string')
    && Array.isArray(value.history) && value.history.every(history);
}
function opportunityPage(value: unknown, customerId: string): value is OpportunityPage {
  return record(value) && Array.isArray(value.items) && value.items.length <= OPPORTUNITY_LIMITS.page
    && value.items.every(item => opportunity(item, customerId)) && Number.isSafeInteger(value.total) && Number(value.total) >= value.items.length
    && new Set(value.items.map(item => item.opportunityId)).size === value.items.length;
}
async function invoke<T>(channel: string, input: unknown, valid: (data: unknown) => data is T, invalidMessage: string): Promise<Result<T>> {
  try {
    const result: unknown = await window.api.invoke(channel, input);
    if (record(result) && result.ok === true && valid(result.data)) return { ok: true, data: result.data };
    if (record(result) && result.ok === false && record(result.error) && typeof result.error.code === 'string' && typeof result.error.message === 'string') return result as Result<T>;
    return { ok: false, error: { code: 'UNAVAILABLE', message: invalidMessage } };
  } catch {
    // A missing IPC response cannot establish whether the center committed; preserve the request for retry.
    return { ok: false, error: { code: 'UNAVAILABLE', message: '商机中心连接中断，请重试' } };
  }
}
function moneyIssue(amount: string, currency: string): string | null {
  if (Boolean(amount.trim()) !== Boolean(currency.trim())) return '金额和币种请一并填写';
  if (!amount.trim()) return null;
  const pattern = new RegExp(`^(0|[1-9][0-9]{0,${OPPORTUNITY_LIMITS.amountWholeDigits - 1}})(?:[.][0-9]{1,${OPPORTUNITY_LIMITS.amountFractionDigits}})?$`);
  if (!pattern.test(amount.trim()) || !/^[A-Z]{3}$/.test(currency.trim().toUpperCase())) return '请填写有效金额及三位币种';
  return null;
}
function terminal(value: OpportunityStage): boolean { return value === 'closed_won' || value === 'closed_lost'; }
function highlightedId(): string | undefined { return new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('opportunityId') || undefined; }

/** Mounted with an account/customer key so requests from the previous identity cannot update this surface. */
export function Opportunities({ detail, canCreate, onChange, onSelect, selectedOpportunityId, onLocked }: { detail: LeadDetail; canCreate: boolean; onChange?: () => void; onSelect?: (opportunity: Opportunity | undefined) => void; selectedOpportunityId?: string; onLocked?: (locked: boolean) => void }) {
  const [items, setItems] = useState<Opportunity[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editing, setEditing] = useState<StageDraft | null>(null);
  const [highlight, setHighlight] = useState(highlightedId);
  const [focused, setFocused] = useState<Opportunity | null>(null);
  const alive = useRef(true);
  const mutation = useRef(false);
  const pending = useRef<PendingCommand | null>(null);
  const listSequence = useRef(0);
  const epoch = useRef(0);
  const customerVersion = useRef(detail.version);
  const draftCustomerVersion = useRef(detail.version);
  const revalidate = useRef(false);
  const lockCallback = useRef(onLocked); lockCallback.current = onLocked;
  const latestParent = useRef({ selectedOpportunityId, onSelect, onChange }); latestParent.current = { selectedOpportunityId, onSelect, onChange };
  const locked = busy || uncertain || needsRefresh;

  async function refresh(): Promise<boolean> {
    if (mutation.current || pending.current) return false;
    const sequence = ++listSequence.current;
    const startedEpoch = epoch.current;
    setLoading(true);
    const [result, focusedResult] = await Promise.all([
      invoke(CHANNEL.OPPORTUNITY_LIST, { customerId: detail.customerId, limit: OPPORTUNITY_LIMITS.page, offset: (page - 1) * OPPORTUNITY_LIMITS.page }, (data): data is OpportunityPage => opportunityPage(data, detail.customerId), '商机列表响应无效'),
      highlight ? invoke(CHANNEL.OPPORTUNITY_DETAIL, highlight, (value): value is Opportunity => opportunity(value, detail.customerId) && value.opportunityId === highlight, '商机详情响应无效') : Promise.resolve(null),
    ]);
    if (!alive.current || sequence !== listSequence.current || startedEpoch !== epoch.current) return false;
    setLoading(false);
    if (!result.ok) {
      setError(result.error.message);
      if (ACCESS_ERRORS.includes(result.error.code)) { setItems([]); setFocused(null); setTotal(0); latestParent.current.onSelect?.(undefined); }
      return false;
    }
    setItems(result.data.items); setTotal(result.data.total);
    if (focusedResult) {
      if (focusedResult.ok) setFocused(focusedResult.data);
      else { setFocused(null); setError(focusedResult.error.message); }
    } else setFocused(null);
    if (revalidate.current) {
      setEditing(current => {
        if (!current) return null;
        const fresh = result.data.items.find(item => item.opportunityId === current.row.opportunityId);
        return fresh ? (!terminal(fresh.stage) && fresh.canManage ? { ...current, row: fresh } : null) : current;
      });
    }
    return !focusedResult || focusedResult.ok;
  }

  async function refreshRejectedDraft(): Promise<void> {
    setNeedsRefresh(true); revalidate.current = true;
    let customerOk = true;
    if (creating) {
      const result = await invoke(CHANNEL.DETAIL, detail.customerId, (value): value is LeadDetail => record(value) && value.customerId === detail.customerId && Number.isSafeInteger(value.version) && Number(value.version) > 0, '客户响应无效');
      if (!alive.current) return;
      customerOk = result.ok;
      if (result.ok) { customerVersion.current = result.data.version; draftCustomerVersion.current = result.data.version; }
      else setError(result.error.message);
    } else if (editing) {
      const id = editing.row.opportunityId;
      const result = await invoke(CHANNEL.OPPORTUNITY_DETAIL, id, (value): value is Opportunity => opportunity(value, detail.customerId) && value.opportunityId === id, '商机详情响应无效');
      if (!alive.current) return;
      customerOk = result.ok;
      if (result.ok) {
        const fresh = result.data;
        setEditing(current => current && current.row.opportunityId === id && fresh.canManage && !terminal(fresh.stage) ? { ...current, row: fresh } : null);
        setFocused(current => current?.opportunityId === id ? fresh : current);
      } else setError(result.error.message);
    }
    const listOk = await refresh();
    if (!alive.current) return;
    if (customerOk && listOk) { setNeedsRefresh(false); revalidate.current = false; }
  }

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; epoch.current++; listSequence.current++; lockCallback.current?.(false); };
  }, []);
  useEffect(() => { lockCallback.current?.(locked); }, [locked]);
  useEffect(() => { customerVersion.current = detail.version; }, [detail.version]);
  useEffect(() => {
    void refresh();
    return () => { listSequence.current++; };
  }, [page, highlight]);
  useVisiblePolling(() => { if (!revalidate.current) void refresh(); }, ONLINE_LIMITS.pollMs);
  useEffect(() => {
    const changed = () => setHighlight(highlightedId());
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  useEffect(() => {
    if (highlight) document.getElementById(`opportunity-${highlight}`)?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [highlight, items, focused]);

  async function save(kind: 'create' | 'stage'): Promise<void> {
    if (mutation.current || needsRefresh) return;
    if (!pending.current) {
      const fields = kind === 'create' ? draft : editing;
      if (!fields) return;
      const issue = moneyIssue(fields.amount, fields.currency);
      if (issue) { setError(issue); return; }
      const money = fields.amount.trim() ? { amount: fields.amount.trim(), currency: fields.currency.trim().toUpperCase() } : {};
      if (kind === 'create') {
        if (!draft.title.trim()) { setError('请填写商机标题'); return; }
        const optional = Object.fromEntries(['pol', 'pod', 'containerType', 'description', 'source'].flatMap(key => draft[key as keyof Draft].trim() ? [[key, draft[key as keyof Draft].trim()]] : []));
        pending.current = { channel: CHANNEL.OPPORTUNITY_CREATE, input: { customerId: detail.customerId, expectedCustomerVersion: draftCustomerVersion.current, idempotencyKey: crypto.randomUUID(), title: draft.title.trim(), ...optional, ...money } };
      } else if (editing) {
        if (editing.stage === 'closed_won' && !editing.evidence.trim()) { setError('请填写成交证据'); return; }
        if (editing.stage === 'closed_lost' && !editing.lostReason.trim()) { setError('请填写丢单原因'); return; }
        pending.current = { channel: CHANNEL.OPPORTUNITY_STAGE, input: { opportunityId: editing.row.opportunityId, expectedVersion: editing.row.version, idempotencyKey: crypto.randomUUID(), stage: editing.stage, ...money,
          ...(editing.stage === 'closed_won' ? { evidence: editing.evidence.trim() } : {}), ...(editing.stage === 'closed_lost' ? { lostReason: editing.lostReason.trim() } : {}) } };
      }
    }
    const command = pending.current;
    if (!command) return;
    mutation.current = true; epoch.current++; listSequence.current++;
    setBusy(true); setLoading(false); setError('');
    const result = await invoke(command.channel, command.input, (value): value is Opportunity => opportunity(value, detail.customerId) && (command.channel !== CHANNEL.OPPORTUNITY_STAGE || value.opportunityId === (command.input as OpportunityUpdateStage).opportunityId), '商机保存响应无效，请重试');
    if (!alive.current) return;
    mutation.current = false;
    if (result.ok) {
      pending.current = null; setUncertain(false); setEditing(null); setCreating(false); setDraft(EMPTY_DRAFT);
      setItems(current => current.map(item => item.opportunityId === result.data.opportunityId ? result.data : item));
      setFocused(current => current?.opportunityId === result.data.opportunityId ? result.data : current);
      if (latestParent.current.selectedOpportunityId === result.data.opportunityId) latestParent.current.onSelect?.(result.data);
      latestParent.current.onChange?.();
      await refresh();
    } else {
      setError(result.error.message);
      if (PREWRITE_ERRORS.includes(result.error.code)) {
        pending.current = null; setUncertain(false);
        await refreshRejectedDraft();
      } else setUncertain(true);
    }
    if (alive.current) setBusy(false);
  }

  const rows = focused && !items.some(item => item.opportunityId === focused.opportunityId) ? [focused, ...items] : items;
  const moneyFields = (fields: Draft | StageDraft, change: (amount: string, currency: string) => void, label: string) => <div className="customer-opportunity-money">
    <Input aria-label={`${label}金额`} placeholder="金额（可选）" value={fields.amount} maxLength={OPPORTUNITY_LIMITS.amountWholeDigits + OPPORTUNITY_LIMITS.amountFractionDigits + 1} disabled={locked} onChange={event => change(event.target.value, fields.currency)} />
    <Input aria-label={`${label}币种`} placeholder="币种" value={fields.currency} maxLength={CURRENCY_LENGTH} disabled={locked} onChange={event => change(fields.amount, event.target.value)} />
  </div>;
  return <section className="customer-detail-section customer-opportunities">
    <div className="customer-receipt-heading"><h2>商机</h2><Space size="small"><Button type="text" size="small" disabled={busy || uncertain} onClick={() => { setError(''); if (needsRefresh) void refreshRejectedDraft(); else void refresh(); }}>刷新</Button>{canCreate && !creating && <Button size="small" disabled={locked} onClick={() => { draftCustomerVersion.current = customerVersion.current; setCreating(true); setEditing(null); setError(''); }}>新增商机</Button>}</Space></div>
    {error && <Alert type="error" message={error} />}
    {creating && <div className="customer-opportunity-draft">
      <Input aria-label="商机标题" placeholder="商机标题" value={draft.title} maxLength={OPPORTUNITY_LIMITS.title} disabled={locked} onChange={event => setDraft(current => ({ ...current, title: event.target.value }))} />
      <div className="customer-opportunity-route">{(['pol', 'pod', 'containerType'] as const).map((key, index) => <Input key={key} aria-label={['起运港', '目的港', '箱型'][index]} placeholder={['起运港（可选）', '目的港（可选）', '箱型（可选）'][index]} value={draft[key]} maxLength={OPPORTUNITY_LIMITS.route} disabled={locked} onChange={event => setDraft(current => ({ ...current, [key]: event.target.value }))} />)}</div>
      {moneyFields(draft, (amount, currency) => setDraft(current => ({ ...current, amount, currency })), '新商机')}
      <details><summary>其他资料</summary><Input aria-label="商机来源" placeholder="来源（可选）" value={draft.source} maxLength={OPPORTUNITY_LIMITS.source} disabled={locked} onChange={event => setDraft(current => ({ ...current, source: event.target.value }))} /><Input.TextArea aria-label="需求说明" placeholder="需求说明（可选）" rows={2} value={draft.description} maxLength={OPPORTUNITY_LIMITS.description} disabled={locked} onChange={event => setDraft(current => ({ ...current, description: event.target.value }))} /></details>
      <Space><Button type="primary" size="small" loading={busy} onClick={() => void save('create')}>{uncertain ? '重试' : '创建商机'}</Button><Button size="small" disabled={locked} onClick={() => { setCreating(false); setDraft(EMPTY_DRAFT); setError(''); }}>取消</Button></Space>
    </div>}
    {loading && !rows.length ? <div className="customer-opportunity-empty" role="status">加载商机…</div> : !rows.length ? <div className="customer-opportunity-empty">暂无商机</div> : rows.map(row => {
      const active = editing?.row.opportunityId === row.opportunityId;
      return <article id={`opportunity-${row.opportunityId}`} key={row.opportunityId} className={`customer-opportunity-row${highlight === row.opportunityId ? ' customer-opportunity-highlight' : ''}`}>
        <div className="customer-opportunity-heading"><strong>{row.title}</strong><span>{OPPORTUNITY_STAGE_LABELS[row.stage]}</span></div>
        <div className="customer-opportunity-meta">{(row.pol || row.pod) && <span>{row.pol || '—'} → {row.pod || '—'}</span>}{row.containerType && <span>{row.containerType}</span>}{row.amount !== null && row.currency !== null && <span>{row.amount} {row.currency}</span>}</div>
        {row.evidence && <div className="customer-opportunity-evidence">成交证据：{row.evidence}</div>}{row.lostReason && <div className="customer-opportunity-evidence">丢单原因：{row.lostReason}</div>}
        <div className="customer-opportunity-actions">
          {row.canManage && !terminal(row.stage) && <select aria-label={`商机阶段-${row.opportunityId}`} value={active ? editing.stage : row.stage} disabled={locked || creating} onChange={event => { setEditing({ row, stage: event.target.value as OpportunityStage, amount: row.amount || '', currency: row.currency || '', lostReason: '', evidence: '' }); setError(''); }}>
            {OPPORTUNITY_STAGES.map(value => <option key={value} value={value}>{OPPORTUNITY_STAGE_LABELS[value]}</option>)}
          </select>}
          {onSelect && <Button size="small" type="text" disabled={locked} onClick={() => onSelect(selectedOpportunityId === row.opportunityId ? undefined : row)}>{selectedOpportunityId === row.opportunityId ? '取消跟进' : '跟进'}</Button>}
        </div>
        {active && <div className="customer-opportunity-stage-draft">
          {moneyFields(editing, (amount, currency) => setEditing(current => current ? { ...current, amount, currency } : null), `商机-${row.opportunityId}-`)}
          {editing.stage === 'closed_won' && <Input aria-label={`成交证据-${row.opportunityId}`} placeholder="成交证据（订舱号、合同或订单引用）" value={editing.evidence} maxLength={OPPORTUNITY_LIMITS.evidence} disabled={locked} onChange={event => setEditing(current => current ? { ...current, evidence: event.target.value } : null)} />}
          {editing.stage === 'closed_lost' && <Input aria-label={`丢单原因-${row.opportunityId}`} placeholder="丢单原因" value={editing.lostReason} maxLength={OPPORTUNITY_LIMITS.reason} disabled={locked} onChange={event => setEditing(current => current ? { ...current, lostReason: event.target.value } : null)} />}
          <Space><Button aria-label={`保存阶段-${row.opportunityId}`} type="primary" size="small" loading={busy} onClick={() => void save('stage')}>{uncertain ? '重试' : '保存阶段'}</Button><Button size="small" disabled={locked} onClick={() => { setEditing(null); setError(''); }}>取消</Button></Space>
        </div>}
        {row.history.length > 0 && <details className="customer-opportunity-history"><summary>阶段记录（{row.history.length}）</summary>{row.history.map(event => <div key={event.historyId}><span>{event.fromStage ? `${OPPORTUNITY_STAGE_LABELS[event.fromStage]} → ` : ''}{OPPORTUNITY_STAGE_LABELS[event.toStage]}</span><span>{new Date(event.occurredAt).toLocaleString('zh-CN')}{event.actorName ? ` · ${event.actorName}` : ''}</span>{event.amount !== null && event.currency !== null && <span>{event.amount} {event.currency}</span>}{event.evidence && <span>成交证据：{event.evidence}</span>}{event.lostReason && <span>丢单原因：{event.lostReason}</span>}</div>)}</details>}
      </article>;
    })}
    {total > OPPORTUNITY_LIMITS.page && <Pagination size="small" current={page} total={total} pageSize={OPPORTUNITY_LIMITS.page} showSizeChanger={false} disabled={locked} onChange={setPage} />}
  </section>;
}
