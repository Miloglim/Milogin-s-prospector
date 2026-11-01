import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Inbox, MessageSquareReply } from 'lucide-react';
import {
  ONLINE_CHANNELS,
  ONLINE_LIMITS,
  TEAM_ATTENTION_LIMITS,
  type Result,
  type TeamAttentionItem,
  type TeamAttentionPage,
  type TeamAttentionStatus,
  type TeamAttentionTransitionAction,
} from '../../../shared/online-crm';
import { useIdentity } from '../../IdentityContext';
import { useVisiblePolling } from '../../hooks/useVisiblePolling';

type AttentionFilter = 'all' | TeamAttentionStatus;

const STATUS_LABELS: Record<TeamAttentionStatus, string> = {
  open: '待确认',
  acknowledged: '处理中',
  resolved: '已完成',
  dismissed: '已驳回',
};
const REASON_LABELS: Record<TeamAttentionItem['reason'], string> = {
  important_reply: '重要回复',
  quote_overdue: '报价逾期',
  unhandled_inquiry: '待处理询盘',
  bounce_correction: '退信修正',
};
const PRIORITY_LABELS: Record<TeamAttentionItem['priority'], string> = {
  normal: '普通',
  important: '重要',
  urgent: '紧急',
};
const FILTERS: readonly AttentionFilter[] = ['all', 'open', 'acknowledged', 'resolved', 'dismissed'];

function invoke<T>(channel: string, ...args: unknown[]): Promise<Result<T>> {
  return window.api.invoke(channel, ...args) as Promise<Result<T>>;
}

function scopeLabel(scope?: TeamAttentionPage['scope']): string {
  if (scope === 'member') return '我的关注';
  if (scope === 'supervisor') return '团队关注';
  return '关注项';
}

function when(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function customerHref(item: TeamAttentionItem): string {
  const params = new URLSearchParams({ view: 'table', centerContact: String(item.contactId), centerCustomer: item.customerId });
  return `#/customers?${params.toString()}`;
}

function filterCount(page: TeamAttentionPage | undefined, filter: AttentionFilter): number {
  if (!page) return 0;
  return filter === 'all' ? page.total : page.counts[filter];
}

export function TeamAttentionPanel({ online, focusItemId }: { online: boolean; focusItemId?: string | null }) {
  const session = useIdentity();
  const identity = session.identity;
  const [filter, setFilter] = useState<AttentionFilter>('all');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [resolving, setResolving] = useState<TeamAttentionItem | null>(null);
  const [result, setResult] = useState('');
  const [retryLocked, setRetryLocked] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const retries = useRef(new Map<string, string>());
  const itemRefs = useRef(new Map<string, HTMLElement>());
  const focusedItem = useRef<string | null>(null);

  const query = useQuery({
    queryKey: ['team-attention', session.baseUrl, identity?.userId, identity?.crmRoles, identity?.crmCapabilities],
    enabled: online && !!identity,
    queryFn: () => invoke<TeamAttentionPage>(ONLINE_CHANNELS.TEAM_ATTENTION_LIST, {
      limit: TEAM_ATTENTION_LIMITS.pageMax,
      offset: 0,
    }),
  });
  const page = query.data?.ok ? query.data.data : undefined;
  const items = page?.items ?? [];
  const visibleItems = useMemo(() => filter === 'all' ? items : items.filter(item => item.status === filter), [filter, items]);
  const queryError = query.data && !query.data.ok ? query.data.error.message : '';

  useVisiblePolling(async () => { await query.refetch(); }, ONLINE_LIMITS.pollMs, online);

  useEffect(() => {
    if (!focusItemId) {
      focusedItem.current = null;
      return;
    }
    if (!items.length || focusedItem.current === focusItemId) return;
    setFilter('all');
    const element = itemRefs.current.get(focusItemId);
    if (element && typeof element.scrollIntoView === 'function') element.scrollIntoView({ block: 'nearest' });
    element?.focus({ preventScroll: true });
    if (element) focusedItem.current = focusItemId;
  }, [focusItemId, items]);

  const transition = async (item: TeamAttentionItem, action: TeamAttentionTransitionAction, actionResult?: string) => {
    const resultText = actionResult?.trim();
    if (action === 'resolve' && !resultText) return;
    const signature = JSON.stringify([item.itemId, action, item.version, resultText ?? '']);
    let idempotencyKey = retries.current.get(signature);
    if (!idempotencyKey) {
      idempotencyKey = crypto.randomUUID();
      retries.current.set(signature, idempotencyKey);
    }
    setPendingId(item.itemId);
    setError('');
    setFeedback('');
    try {
      const response = await invoke<TeamAttentionItem>(ONLINE_CHANNELS[action === 'acknowledge' ? 'TEAM_ATTENTION_ACKNOWLEDGE' : action === 'dismiss' ? 'TEAM_ATTENTION_DISMISS' : 'TEAM_ATTENTION_RESOLVE'], item.itemId, {
        expectedVersion: item.version,
        idempotencyKey,
        ...(resultText ? { result: resultText } : {}),
      });
      if (!response.ok) {
        if (response.error.code !== 'UNAVAILABLE') {
          retries.current.delete(signature);
          setRetryLocked(false);
        } else {
          setRetryLocked(true);
        }
        setError(response.error.message);
        if (response.error.code === 'CONFLICT') await query.refetch();
        return;
      }
      retries.current.delete(signature);
      setRetryLocked(false);
      setResolving(null);
      setResult('');
      setFeedback(action === 'resolve' ? '已提交处理结果' : action === 'acknowledge' ? '已确认关注项' : '已驳回关注项');
      await query.refetch();
    } catch {
      // Unknown transport outcomes keep the same key so a retry cannot duplicate the state change.
      setRetryLocked(true);
      setError('中心响应中断，可使用相同操作重试');
    } finally {
      setPendingId(null);
    }
  };

  const startResolve = (item: TeamAttentionItem) => {
    setResolving(item);
    setResult('');
    setRetryLocked(false);
    setError('');
    window.setTimeout(() => document.getElementById(`team-attention-result-${item.itemId}`)?.focus(), 0);
  };

  return <section className="team-attention-panel" aria-label={scopeLabel(page?.scope)}>
    <div className="team-attention-heading">
      <div><h2>{scopeLabel(page?.scope)}</h2><span>{page?.total ?? 0}</span></div>
      <div className="team-attention-filters" role="group" aria-label="关注项状态">
        {FILTERS.map(value => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>
          {value === 'all' ? '全部' : STATUS_LABELS[value]} <span>{filterCount(page, value)}</span>
        </button>)}
      </div>
    </div>
    {feedback && <div className="team-attention-feedback" role="status">{feedback}</div>}
    {(error || queryError || (!online && query.data && !query.data.ok)) && <div className="team-attention-error" role="alert">{error || queryError || '联网后读取关注项'}</div>}
    {query.isLoading ? <div className="team-attention-state">正在读取关注项</div>
      : !online && !page ? <div className="team-attention-state">联网后读取关注项</div>
        : visibleItems.length === 0 ? <div className="team-attention-state">暂无关注项</div>
          : <div className="team-attention-list">
            {visibleItems.map(item => {
              const isResolving = resolving?.itemId === item.itemId;
              return <article
                key={item.itemId}
                ref={node => { if (node) itemRefs.current.set(item.itemId, node); else itemRefs.current.delete(item.itemId); }}
                className={`team-attention-row${focusItemId === item.itemId ? ' is-focused' : ''}`}
                data-item-id={item.itemId}
                tabIndex={-1}
              >
                <span className={`team-attention-priority is-${item.priority}`} aria-label={`优先级 ${PRIORITY_LABELS[item.priority]}`} />
                <div className="team-attention-copy">
                  <div className="team-attention-title-line">
                    <strong>{item.customerName}</strong>
                    <span>{REASON_LABELS[item.reason]}</span>
                    <span>{PRIORITY_LABELS[item.priority]}</span>
                    <span className={`is-status-${item.status}`}>{STATUS_LABELS[item.status]}</span>
                  </div>
                  <div className="team-attention-meta">
                    <span>{item.contactName}</span>
                    <span>{item.sourceSupervisorName} · {item.targetMemberName}</span>
                    <time dateTime={item.updatedAt}>{when(item.updatedAt)}</time>
                  </div>
                  {item.note && <p>{item.note}</p>}
                  {item.result && <p className="team-attention-result"><MessageSquareReply aria-hidden="true" />{item.result}</p>}
                </div>
                <div className="team-attention-links">
                  <a href={customerHref(item)}><ExternalLink aria-hidden="true" />客户</a>
                  <a href="#/inbox"><Inbox aria-hidden="true" />收件箱</a>
                </div>
                {(item.canAcknowledge || item.canDismiss || item.canResolve) && <div className="team-attention-actions">
                  {item.canAcknowledge && <button type="button" disabled={pendingId === item.itemId} onClick={() => void transition(item, 'acknowledge')}>确认</button>}
                  {item.canDismiss && <button type="button" disabled={pendingId === item.itemId} onClick={() => void transition(item, 'dismiss')}>驳回</button>}
                  {item.canResolve && <button type="button" className="is-primary" disabled={pendingId === item.itemId} onClick={() => startResolve(item)}>完成</button>}
                </div>}
                {isResolving && <form className="team-attention-result-form" onSubmit={event => { event.preventDefault(); void transition(item, 'resolve', result); }}>
                  <textarea id={`team-attention-result-${item.itemId}`} aria-label={`${item.customerName} 处理结果`} value={result} maxLength={TEAM_ATTENTION_LIMITS.result} placeholder="填写处理结果" disabled={retryLocked} onChange={event => setResult(event.target.value)} />
                  <div><span>{result.length}/{TEAM_ATTENTION_LIMITS.result}</span><button type="button" disabled={pendingId === item.itemId || retryLocked} onClick={() => setResolving(null)}>取消</button><button type="submit" className="is-primary" disabled={pendingId === item.itemId || !result.trim()}>{retryLocked ? '重试' : '提交'}</button></div>
                </form>}
              </article>;
            })}
          </div>}
  </section>;
}
