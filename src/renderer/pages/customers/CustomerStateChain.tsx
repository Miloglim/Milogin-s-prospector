import { CheckOutlined, EditOutlined, HistoryOutlined, UndoOutlined } from '@ant-design/icons';
import { Button, Input, Modal, Select, Tooltip, message } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { type CustomerStatus, type CustomerStatusState, type CustomerStatusView } from '../../../../server/core/customer-status';
import { customerJourneyView, CUSTOMER_JOURNEY_STEPS, type CustomerJourneyFacts, type CustomerJourneyState } from '../../../../server/core/customer-state';
import { ONLINE_CHANNELS } from '../../../shared/online-crm';

const STATUS_SOURCE_LABELS: Record<string, 'AI 识别' | '人工记录' | '系统识别' | '导入'> = {
  ai: 'AI 识别', human: '人工记录', system: '系统识别', import: '导入',
};
const STATUS_LABELS: Record<CustomerJourneyState, string> = Object.fromEntries([
  ...CUSTOMER_JOURNEY_STEPS.map(step => [step.key, step.label]), ['lost', '已流失'],
]) as Record<CustomerJourneyState, string>;
const CORRECTION_OPTIONS = [...CUSTOMER_JOURNEY_STEPS.map(step => ({ value: step.key, label: step.label })), { value: 'lost', label: '已流失' }];

function time(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function CustomerStateChain({ facts, compact = false, customerId, contactId }: { facts: CustomerJourneyFacts; compact?: boolean; customerId?: string; contactId?: number }) {
  const [remote, setRemote] = useState<CustomerStatusView | null>(null);
  const [correcting, setCorrecting] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [target, setTarget] = useState<CustomerStatus>('contacted');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const track = useRef<HTMLDivElement>(null);
  const current = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!customerId) return;
    let active = true;
    void window.api.invoke(ONLINE_CHANNELS.CUSTOMER_STATUS, customerId).then(result => {
      if (active && result.ok) setRemote(result.data as CustomerStatusView);
    });
    return () => { active = false; };
  }, [customerId, reload]);

  const state = remote?.state ?? null;
  const view = customerJourneyView({ ...facts, status: state?.status, sourceLabel: state ? STATUS_SOURCE_LABELS[state.source] ?? '状态账本' : undefined });

  useEffect(() => {
    const element = track.current;
    if (!element) return;
    const revealCurrent = () => {
      if (element.scrollWidth <= element.clientWidth + 1 || !current.current) { element.scrollLeft = 0; return; }
      element.scrollLeft = Math.max(0, current.current.offsetLeft - (element.clientWidth - current.current.offsetWidth) / 2);
    };
    revealCurrent();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(revealCurrent);
    observer.observe(element);
    return () => observer.disconnect();
  }, [view.state]);

  async function saveCorrection() {
    if (!customerId || !reason.trim()) { message.warning('请填写纠正原因'); return; }
    setBusy(true);
    try {
      const result = await window.api.invoke(ONLINE_CHANNELS.CUSTOMER_STATUS_CORRECT, {
        customerId, ...(contactId ? { contactId } : {}), expectedVersion: state?.version ?? 0,
        status: target, reason: reason.trim(), idempotencyKey: crypto.randomUUID(),
      });
      if (!result.ok) { message.error(result.error.message); return; }
      setRemote(current => current ? { ...current, state: result.data as CustomerStatusState } : current);
      setCorrecting(false); setReason(''); setReload(value => value + 1);
      message.success('客户状态已纠正');
    } finally { setBusy(false); }
  }

  async function resumeAi() {
    if (!customerId || !state) return;
    setBusy(true);
    try {
      const result = await window.api.invoke(ONLINE_CHANNELS.CUSTOMER_STATUS_RESUME, { customerId, expectedVersion: state.version, idempotencyKey: crypto.randomUUID() });
      if (!result.ok) { message.error(result.error.message); return; }
      setRemote(current => current ? { ...current, state: result.data as CustomerStatusState } : current);
      setReload(value => value + 1);
      message.success('已恢复 AI 自动维护');
    } finally { setBusy(false); }
  }

  return <section className={`customer-state-chain${compact ? ' is-compact' : ''}`} aria-label="客户状态链">
    <header>
      <span>客户状态</span>
      <strong className={view.lost ? 'is-lost' : ''}>{view.label}</strong>
      {state?.manualLocked && <em>人工锁定</em>}
      <small>{view.source}</small>
      {customerId && <div className="customer-state-chain-actions">
        <Tooltip title="查看状态记录"><Button type="text" size="small" aria-label="查看客户状态记录" icon={<HistoryOutlined />} onClick={() => setHistoryOpen(true)} /></Tooltip>
        <Tooltip title="纠正状态"><Button type="text" size="small" aria-label="纠正客户状态" icon={<EditOutlined />} onClick={() => { setTarget((state?.status ?? 'contacted') as CustomerStatus); setCorrecting(true); }} /></Tooltip>
        {state?.manualLocked && <Tooltip title="恢复 AI 自动维护"><Button type="text" size="small" aria-label="恢复 AI 自动维护" icon={<UndoOutlined />} loading={busy} onClick={() => void resumeAi()} /></Tooltip>}
      </div>}
    </header>
    <div className="customer-state-chain-track" ref={track}>
      {view.steps.map((step, index) => <div key={step.key} className={`customer-state-node is-${step.status}`} ref={step.status === 'current' ? current : undefined} aria-current={step.status === 'current' ? 'step' : undefined}>
        <span className="customer-state-node-dot" aria-hidden="true">{step.status === 'done' ? <CheckOutlined /> : index + 1}</span>
        <span className="customer-state-node-label">{step.label}</span>
        {index < view.steps.length - 1 && <span className="customer-state-node-line" aria-hidden="true" />}
      </div>)}
    </div>
    {view.lost && <div className="customer-state-chain-branch"><span>已流失</span><small>关系阶段记录为流失，保留历史状态链</small></div>}

    <Modal title="纠正客户状态" open={correcting} confirmLoading={busy} okText="保存纠正" cancelText="取消" onOk={() => void saveCorrection()} onCancel={() => setCorrecting(false)}>
      <div className="customer-state-correction">
        <label>目标状态<Select value={target} options={CORRECTION_OPTIONS} onChange={value => setTarget(value as CustomerStatus)} /></label>
        <label>纠正原因<Input.TextArea rows={3} maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} placeholder="说明为什么当前状态不正确" /></label>
        <small>保存后会锁定自动更新，AI 只能继续生成建议。</small>
      </div>
    </Modal>

    <Modal title="客户状态记录" open={historyOpen} footer={null} onCancel={() => setHistoryOpen(false)} width={560}>
      <div className="customer-state-history">
        {!remote?.events?.length ? <div className="customer-state-history-empty">暂无状态记录</div> : remote.events.map(event => <div key={event.eventId} className="customer-state-history-row">
          <span>{STATUS_LABELS[event.status] ?? event.status}</span>
          <strong>{event.reason || STATUS_SOURCE_LABELS[event.source] || event.source}</strong>
          <small>{time(event.occurredAt)}</small>
        </div>)}
      </div>
    </Modal>
  </section>;
}
