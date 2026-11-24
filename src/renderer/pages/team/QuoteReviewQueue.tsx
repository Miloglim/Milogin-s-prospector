import { useEffect, useState } from 'react';
import { Input, Modal, message } from 'antd';
import { Check, X } from 'lucide-react';
import { ONLINE_CHANNELS, ONLINE_LIMITS, type QuoteReviewDecision, type QuoteReviewListItem, type QuoteReviewPage } from '../../../shared/online-crm';
import { useVisiblePolling } from '../../hooks/useVisiblePolling';

const REVIEW_LIMIT = 20;
const notePlaceholder = '补充核对意见（可选）';

function candidateLine(item: QuoteReviewListItem): string {
  const candidate = item.selectedCandidate;
  if (!candidate) return '尚未选定运价';
  return [candidate.carrier, [candidate.pol, candidate.pod].filter(Boolean).join(' → ') || null, candidate.containerType].filter(Boolean).join(' · ') || '运价待确认';
}

function priceLine(item: QuoteReviewListItem): string {
  const candidate = item.selectedCandidate;
  if (!candidate || candidate.price == null) return '未定价';
  return `${candidate.currency || 'USD'} ${candidate.price.toLocaleString('en-US')}`;
}

function when(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(parsed) : '';
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<{ ok: boolean; data?: T; error?: { message: string } } | null> {
  try { return await window.api.invoke(channel, ...args) as { ok: boolean; data?: T; error?: { message: string } }; }
  catch { return null; }
}

export function QuoteReviewQueue({ enabled }: { enabled: boolean }) {
  const [items, setItems] = useState<QuoteReviewListItem[]>([]);
  const [pending, setPending] = useState<{ item: QuoteReviewListItem; action: 'approve' | 'reject' } | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    if (!enabled) return;
    const result = await invoke<QuoteReviewPage>(ONLINE_CHANNELS.QUOTE_REVIEW_LIST, { status: 'pending', limit: REVIEW_LIMIT, offset: 0 });
    if (result?.ok && result.data) setItems(result.data.items);
  };
  useEffect(() => { void load(); }, [enabled]);
  useVisiblePolling(load, ONLINE_LIMITS.pollMs, enabled);

  const decide = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const decision: QuoteReviewDecision = { action: pending.action, ...(note.trim() ? { note: note.trim() } : {}) };
      const result = await invoke(ONLINE_CHANNELS.QUOTE_REVIEW_DECIDE, pending.item.reviewId, decision);
      if (!result?.ok) { message.warning(result?.error?.message || '审核处理失败'); return; }
      setItems(current => current.filter(entry => entry.reviewId !== pending.item.reviewId));
      const outcome = pending.action === 'approve' ? '报价已通过' : '报价已退回';
      const detail = [pending.item.customerName, candidateLine(pending.item), priceLine(pending.item)].filter(Boolean).join(' · ');
      try {
        await window.api.invoke(ONLINE_CHANNELS.TEAM_MESSAGE_SEND, {
          recipientUserId: pending.item.requestedBy,
          body: `${outcome}：${detail}${note.trim() ? `\n核对意见：${note.trim()}` : ''}`,
          idempotencyKey: crypto.randomUUID(),
        });
      } catch { /* 审核结果已保存，聊天回执失败不影响状态 */ }
      message.success(pending.action === 'approve' ? '已通过报价' : '已退回报价');
      setPending(null); setNote('');
    } finally { setBusy(false); }
  };

  if (!enabled || items.length === 0) return null;
  return <section className="personal-review-panel" aria-label="待确认报价">
    <div className="personal-content-heading"><strong>待确认报价</strong><span>{items.length} 项</span></div>
    <div className="personal-review-list">
      {items.map(item => <article key={item.reviewId} className="personal-review-row">
        <div className="personal-review-main">
          <strong>{item.customerName || item.subject || '客户报价'}</strong>
          <span>{candidateLine(item)}</span>
          <small>{item.requestedByName || '同事'} 提交 · {when(item.createdAt)}{item.reason ? ` · ${item.reason}` : ''}</small>
        </div>
        <span className="personal-review-price">{priceLine(item)}</span>
        <div className="personal-review-actions">
          <button type="button" className="is-approve" title="通过报价" aria-label="通过报价" onClick={() => { setPending({ item, action: 'approve' }); setNote(''); }}><Check aria-hidden="true" /></button>
          <button type="button" className="is-reject" title="退回报价" aria-label="退回报价" onClick={() => { setPending({ item, action: 'reject' }); setNote(''); }}><X aria-hidden="true" /></button>
        </div>
      </article>)}
    </div>
    <Modal open={Boolean(pending)} title={pending?.action === 'approve' ? '通过报价' : '退回报价'} okText={pending?.action === 'approve' ? '确认通过' : '确认退回'} cancelText="取消" confirmLoading={busy} onOk={() => void decide()} onCancel={() => { setPending(null); setNote(''); }}>
      {pending && <div className="personal-review-confirm">
        <div><strong>{pending.item.customerName}</strong><span>{candidateLine(pending.item)} · {priceLine(pending.item)}</span></div>
        <Input.TextArea value={note} maxLength={500} autoSize={{ minRows: 3, maxRows: 6 }} placeholder={notePlaceholder} onChange={event => setNote(event.target.value)} />
      </div>}
    </Modal>
  </section>;
}
