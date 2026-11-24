import { useEffect, useMemo, useState } from 'react';
import { Button, Drawer, Input, Modal, message } from 'antd';
import { CheckOutlined, ReloadOutlined, SafetyCertificateOutlined, SendOutlined } from '@ant-design/icons';
import type { InboxQuoteCandidate, InboxQuoteCard, InboxQuoteCardState } from '../../../shared/inbox';

const STATE_LABEL: Record<InboxQuoteCardState,string> = {
  analyzing:'正在准备', fields_pending:'待补充运输信息', querying:'正在核价', ready:'已整理运价',
  failed:'暂时无法核价', unmatched:'未匹配联系人', stale:'需要重新核价',
};

const REVIEW_LABEL: Record<string,string> = {
  review_pending: '等待主管确认',
  approved: '主管已确认',
  review_rejected: '主管已退回，需调整',
};

const shortDate = (value: string | null): string => value ? value.slice(5, 10).replace('-', '/') : '';
const priceLabel = (candidate: InboxQuoteCandidate): string => candidate.price == null
  ? '议价'
  : `${candidate.currency || 'USD'} ${candidate.price.toLocaleString('en-US')}`;

export function InboxQuoteCardView({ card, onUpdated }: { card: InboxQuoteCard; onUpdated: () => void }) {
  const [pol, setPol] = useState(''); const [pod, setPod] = useState(''); const [container, setContainer] = useState('');
  const [busy, setBusy] = useState(false); const [draftOpen, setDraftOpen] = useState(false);
  const [draftSubject, setDraftSubject] = useState(''); const [draftBody, setDraftBody] = useState('');
  const [reviewOpen, setReviewOpen] = useState(false); const [reviewReason, setReviewReason] = useState('');
  const [reviewState, setReviewState] = useState<string | null>(null);
  const [editing, setEditing] = useState(card.state === 'fields_pending');
  const [compareOpen, setCompareOpen] = useState(false);

  useEffect(() => {
    if (!card.quoteCaseId) { setReviewState(null); return; }
    let live = true;
    void window.api.invoke('online:quote-case-detail', card.quoteCaseId)
      .then((result: { success?: boolean; ok?: boolean; data?: { draft?: { status?: string } } }) => {
        if (!live || result?.ok === false || result?.success === false) return;
        setReviewState(result?.data?.draft?.status ?? null);
      })
      .catch(() => { /* 中心暂不可达时保留本地卡片，不阻断邮件阅读 */ });
    return () => { live = false; };
  }, [card.quoteCaseId, card.updatedAt]);

  useEffect(() => {
    const value = (key: string) => {
      const raw = card.fields[key] as { value?: unknown } | undefined;
      return typeof raw?.value === 'string' ? raw.value : Array.isArray(raw?.value) ? String(raw.value[0] || '') : '';
    };
    setPol(value('pol')); setPod(value('pod')); setContainer(value('containerTypes'));
  }, [card.updatedAt, card.fields]);

  useEffect(() => {
    setEditing(card.state === 'fields_pending');
  }, [card.messageId, card.state]);

  const ports = useMemo(() => {
    const best = new Map<string, InboxQuoteCandidate>();
    for (const candidate of card.candidates) {
      const key = candidate.pol || '起运港待确认';
      const current = best.get(key);
      if (!current || (candidate.price ?? Number.MAX_SAFE_INTEGER) < (current.price ?? Number.MAX_SAFE_INTEGER)) best.set(key, candidate);
    }
    if (card.selectedCandidate) best.set(card.selectedCandidate.pol || '起运港待确认', card.selectedCandidate);
    return [...best.entries()];
  }, [card.candidates, card.selectedCandidate]);

  const invoke = async <T,>(channel: string, input?: unknown): Promise<T | null> => {
    setBusy(true);
    try {
      const result = await window.api.invoke(channel, input) as { success?: boolean; data?: T; error?: string };
      if (!result?.success) { message.warning(result?.error || '操作暂不可用'); return null; }
      onUpdated(); return result.data ?? null;
    } finally { setBusy(false); }
  };
  const requery = () => invoke('inbox:quoteRequery', { messageId: card.messageId, fields: { pol, pod, containerTypes: container ? [container] : [] } });
  const select = (candidateId: string) => invoke('inbox:quoteSelect', { messageId: card.messageId, candidateId });
  const draft = async () => {
    const result = await invoke<{ subject: string; body: string }>('inbox:quoteDraft', card.messageId);
    if (result) { setDraftSubject(result.subject); setDraftBody(result.body); setDraftOpen(true); }
  };
  const requestReview = async () => {
    setBusy(true);
    try {
      const context = await window.api.invoke('online:team-context') as { success?: boolean; data?: { team?: { leaderUserId?: string; leaderName?: string } | null }; error?: string };
      const reviewerUserId = context?.success ? context.data?.team?.leaderUserId : undefined;
      if (!reviewerUserId) { message.warning('当前没有可用的团队主管'); return; }
      const result = await window.api.invoke('online:quote-case-review', card.quoteId, { reviewerUserId, reason: reviewReason || undefined, linkedMessageId: card.messageKey }) as { success?: boolean; error?: string };
      if (!result?.success) { message.warning(result?.error || '审核请求暂不可用'); return; }
      await window.api.invoke('online:sales-case-transition', card.caseId, { state: 'quote_review', nextAction: '等待主管确认', eventType: 'quote.requested' });
      try {
        await window.api.invoke('online:team-message-send', {
          recipientUserId: reviewerUserId,
          body: `请确认客户报价：${[card.selectedCandidate?.carrier, card.selectedCandidate?.pol, card.selectedCandidate?.pod].filter(Boolean).join(' · ') || card.summary}${reviewReason ? `\n核对点：${reviewReason}` : ''}`,
          idempotencyKey: crypto.randomUUID(),
        });
      } catch { /* the persistent review request remains available when the optional chat ping fails */ }
      setReviewOpen(false); setReviewReason(''); message.success(`已请 ${context.data?.team?.leaderName || '主管'} 确认报价`);
    } finally {
      setBusy(false);
    }
  };

  const selected = card.selectedCandidate;
  const missing = card.state === 'fields_pending';
  const stateHint = card.state === 'analyzing' || card.state === 'querying' ? '正在从运价库筛选候选…'
    : card.state === 'fields_pending' ? '补充起运港、目的港和柜型后再核价。'
    : card.state === 'stale' ? '运价可能已经变化，重新核价后再回复客户。'
    : '';

  return <section className="inbox-quote-card" aria-label="询价运价">
    <div className="inbox-quote-head">
      <strong>运价</strong>
      <span className={`inbox-quote-state is-${card.state}`}>{STATE_LABEL[card.state]}</span>
      {reviewState && REVIEW_LABEL[reviewState] && <span className={`inbox-quote-review is-${reviewState}`}>{REVIEW_LABEL[reviewState]}</span>}
    </div>

    {editing ? <div className="inbox-quote-fields">
      <label><span>起运港</span><Input size="small" value={pol} placeholder="POL" onChange={event => setPol(event.target.value)} /></label>
      <label><span>目的港</span><Input size="small" value={pod} placeholder="POD" onChange={event => setPod(event.target.value)} /></label>
      <label><span>柜型</span><Input size="small" value={container} placeholder="20GP / 40HQ" onChange={event => setContainer(event.target.value)} /></label>
      <div className="inbox-quote-edit-actions">
        <Button size="small" type="primary" icon={<ReloadOutlined />} loading={busy} onClick={() => void requery()}>重新核价</Button>
        {card.state !== 'fields_pending' && <Button size="small" type="text" onClick={() => setEditing(false)}>收起</Button>}
      </div>
    </div> : <div className="inbox-quote-route">
      <span>起运 <b className={pol ? '' : 'is-missing'}>{pol || '待补充'}</b></span>
      <span>目的 <b className={pod ? '' : 'is-missing'}>{pod || '待补充'}</b></span>
      <span><b className={container ? '' : 'is-missing'}>{container || '柜型待补充'}</b></span>
      <button type="button" className="inbox-quote-edit" onClick={() => setEditing(true)}>修改</button>
    </div>}

    {stateHint && <div className={`inbox-quote-hint${missing ? ' is-warn' : ''}`}>{stateHint}</div>}

    {ports.length > 0 && <div className="inbox-quote-ports">
      {ports.map(([port, candidate]) => <div key={port} className={`inbox-quote-port${selected?.id === candidate.id ? ' is-selected' : ''}`}>
        <div className="inbox-quote-port-main">
          <strong>{port}</strong>
          <small>{[candidate.carrier, candidate.containerType].filter(Boolean).join(' · ') || '船司待确认'}{candidate.etd ? ` · ETD ${shortDate(candidate.etd)}` : ''}</small>
        </div>
        <span className="inbox-quote-price">{priceLabel(candidate)}</span>
        <button type="button" className="inbox-quote-pick" disabled={busy} onClick={() => void select(candidate.id)}>
          {selected?.id === candidate.id ? <><CheckOutlined /> 已选</> : '选这条'}
        </button>
      </div>)}
    </div>}

    {!ports.length && !missing && card.state !== 'analyzing' && card.state !== 'querying' && <div className="inbox-quote-hint">这封询价暂时没有可用运价，重新核价或调整运输信息后再试。</div>}
    {card.error && <div className="inbox-quote-error">{card.error}</div>}

    {selected && <div className="inbox-quote-selected">
      <span>{[selected.carrier, selected.containerType].filter(Boolean).join(' · ') || '已选运价'}</span>
      <span>{priceLabel(selected)}{selected.validTo ? ` · 有效至 ${selected.validTo}` : ''}</span>
    </div>}

    <div className="inbox-quote-actions">
      <Button size="small" type="primary" icon={<SendOutlined />} disabled={!selected} loading={busy} onClick={() => void draft()}>起草回复</Button>
      <Button size="small" onClick={() => setCompareOpen(true)} disabled={!card.candidates.length}>对比 {card.candidates.length} 条</Button>
      <Button size="small" icon={<SafetyCertificateOutlined />} disabled={!card.quoteId || !selected} onClick={() => setReviewOpen(true)}>主管确认</Button>
    </div>

    <Drawer open={compareOpen} onClose={() => setCompareOpen(false)} width={520} title={`运价对比 · ${card.candidates.length} 条候选`} className="inbox-quote-drawer">
      <div className="inbox-quote-drawer-route">
        {[pol || '起运港待确认', pod || '目的港待确认', container || '柜型待确认'].join(' · ')}
      </div>
      <div className="inbox-quote-drawer-list">
        {card.candidates.map(candidate => <button key={candidate.id} type="button"
          className={`inbox-quote-drawer-row${selected?.id === candidate.id ? ' is-selected' : ''}`}
          onClick={() => void select(candidate.id)}>
          <span className="inbox-quote-drawer-name">
            <strong>{candidate.carrier || '船司待确认'}</strong>
            <small>{[candidate.pol, candidate.pod].filter(Boolean).join(' → ') || '航线待确认'}{candidate.containerType ? ` · ${candidate.containerType}` : ''}</small>
          </span>
          <span className="inbox-quote-drawer-meta">有效至 {candidate.validTo || '—'}{candidate.etd ? ` · ETD ${shortDate(candidate.etd)}` : ''}</span>
          <span className="inbox-quote-price">{priceLabel(candidate)}</span>
          <span className="inbox-quote-drawer-pick">{selected?.id === candidate.id ? '已选' : '选这条'}</span>
        </button>)}
      </div>
      <div className="inbox-quote-drawer-foot">
        <Button onClick={() => setCompareOpen(false)}>收起</Button>
        <Button type="primary" disabled={!selected} loading={busy} onClick={() => { setCompareOpen(false); void draft(); }}>用这条报价起草</Button>
      </div>
    </Drawer>

    <Modal open={draftOpen} title="回复草稿" onCancel={() => setDraftOpen(false)} footer={null} width={620}>
      <div className="inbox-quote-draft"><Input value={draftSubject} onChange={event => setDraftSubject(event.target.value)} /><Input.TextArea value={draftBody} autoSize={{ minRows: 10, maxRows: 20 }} onChange={event => setDraftBody(event.target.value)} /></div>
    </Modal>
    <Modal open={reviewOpen} title="请主管确认报价" okText="发送确认请求" cancelText="取消" confirmLoading={busy} onOk={() => void requestReview()} onCancel={() => setReviewOpen(false)}>
      <Input.TextArea value={reviewReason} maxLength={500} autoSize={{ minRows: 3, maxRows: 6 }} placeholder="补充需要主管核对的点（可选）" onChange={event => setReviewReason(event.target.value)} />
    </Modal>
  </section>;
}