import { useMemo, useState } from 'react';
import { CheckOutlined, CheckSquareOutlined, ClockCircleOutlined, FileDoneOutlined, InboxOutlined, MailOutlined, RightOutlined, SearchOutlined } from '@ant-design/icons';
import { Input } from 'antd';
import type { AssistantReminder, AssistantReminderFacts, AssistantReminderKind } from '../../shared/assistant';

export type ReminderKind = AssistantReminderKind;

const KIND_META: Record<ReminderKind, { label: string; short: string; action: string; icon: typeof MailOutlined; iconClass: string }> = {
  mail: { label: '客户回复', short: '回复', action: '去回复', icon: MailOutlined, iconClass: 'text-teal-600' },
  quote: { label: '报价确认', short: '报价', action: '去确认报价', icon: FileDoneOutlined, iconClass: 'text-amber-600' },
  task: { label: '到期待办', short: '待办', action: '查看待办', icon: CheckSquareOutlined, iconClass: 'text-sky-600' },
  followup: { label: '停滞跟进', short: '跟进', action: '查看客户', icon: ClockCircleOutlined, iconClass: 'text-slate-500' },
};

export function reminderKind(item: AssistantReminder): ReminderKind {
  if (item.kind) return item.kind;
  if (item.target.startsWith('inbox:')) return 'mail';
  if (item.target === 'team_review') return 'quote';
  if (item.title.startsWith('跟进停了')) return 'followup';
  return 'task';
}

function money(price?: number | null, currency?: string | null): string {
  return price == null ? '' : `${currency || 'USD'} ${price}`;
}

function lane(facts?: AssistantReminderFacts): string {
  return [facts?.pol, facts?.pod].filter(Boolean).join(' -> ');
}

function priorityLabel(priority: AssistantReminder['priority']): string {
  return priority === 1 ? '最优先' : priority === 2 ? '优先' : '留意';
}

function startOfToday(now = Date.now()): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** 事项在真实时间上属于哪天：到期已过或隔天才收到的都算逾期，其余算今天。 */
function overdueOf(item: AssistantReminder, now = Date.now()): boolean {
  if (reminderKind(item) === 'followup') return true;
  const due = item.facts?.dueAt ? Date.parse(item.facts.dueAt) : NaN;
  if (Number.isFinite(due)) return due < now;
  const received = item.facts?.receivedAt ? Date.parse(item.facts.receivedAt) : NaN;
  if (Number.isFinite(received)) return received < startOfToday(now);
  return item.priority === 1;
}

function dayLabel(now = Date.now()): string {
  return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(now);
}

function timeKey(item: AssistantReminder): number {
  const value = Date.parse(item.facts?.dueAt || item.facts?.receivedAt || '');
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

const FILTERS: Array<{ value: 'all' | ReminderKind; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'mail', label: '回复' },
  { value: 'quote', label: '报价' },
  { value: 'task', label: '待办' },
  { value: 'followup', label: '跟进' },
];

function queueTitle(item: AssistantReminder, kind: ReminderKind): string {
  const facts = item.facts;
  if (kind === 'mail') return facts?.subject || item.title.replace(/^客户在等回复：/, '');
  if (kind === 'quote') return lane(facts) || item.title;
  return item.title;
}

function queueSummary(item: AssistantReminder, kind: ReminderKind): string {
  const facts = item.facts;
  if (kind === 'mail') return [facts?.customerName, facts?.senderEmail].filter(Boolean).join(' · ') || item.detail;
  if (kind === 'quote') {
    return [facts?.customerName, money(facts?.price, facts?.currency)].filter(Boolean).join(' · ') || item.detail;
  }
  return item.detail;
}

function queueMeta(item: AssistantReminder, kind: ReminderKind): string {
  const facts = item.facts;
  if (kind === 'mail' || kind === 'quote') {
    if (kind === 'quote' && facts?.validTo) return `有效期 ${facts.validTo}`;
    if (facts?.waitedHours == null) return '';
    return facts.waitedHours < 24 ? `等 ${facts.waitedHours} 小时` : `等 ${Math.floor(facts.waitedHours / 24)} 天`;
  }
  if (kind === 'task') {
    const due = facts?.dueAt ? Date.parse(facts.dueAt) : NaN;
    if (Number.isFinite(due) && due < Date.now()) return '已逾期';
    if (Number.isFinite(due)) return `今天 ${new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(due)} 到期`;
    return `${facts?.total ?? facts?.items?.length ?? 0} 项`;
  }
  return facts?.maxDays != null ? `停了 ${facts.maxDays} 天` : `${facts?.total ?? 0} 个客户`;
}

function QueueRow({ item, selected, done, onSelect, onComplete }: {
  item: AssistantReminder; selected: boolean; done: boolean; onSelect: () => void; onComplete: () => void;
}) {
  const kind = reminderKind(item);
  const meta = KIND_META[kind];
  const Icon = meta.icon;
  const completable = item.facts?.messageId != null;
  const time = queueMeta(item, kind);
  return <div data-task-row className={`relative flex w-full items-start gap-2 py-2 pl-2.5 pr-2.5 transition-colors ${selected ? 'bg-teal-50/70' : 'hover:bg-gray-50'}`}>
    {selected && <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-r bg-teal-700" />}
    {completable
      ? <button type="button" role="checkbox" aria-checked={done} aria-label={`完成 ${queueTitle(item, kind)}`}
        onClick={event => { event.stopPropagation(); onComplete(); }}
        className={`mt-[3px] flex h-4 w-4 flex-none items-center justify-center rounded-[3px] border transition-colors ${done ? 'border-teal-700 bg-teal-700 text-white' : 'border-gray-300 bg-white text-transparent hover:border-teal-600'}`}>
        <CheckOutlined className="text-[9px]" />
      </button>
      : <span className="mt-[3px] flex h-4 w-4 flex-none items-center justify-center"><Icon className={`text-[12px] ${meta.iconClass}`} /></span>}
    <button type="button" onClick={onSelect} aria-current={selected ? 'true' : undefined} className="min-w-0 flex-1 text-left">
      <span className="flex items-baseline gap-2">
        <strong className={`min-w-0 flex-1 truncate text-[13px] font-medium ${done ? 'text-gray-400 line-through' : 'text-gray-800'}`}>{queueTitle(item, kind)}</strong>
        {time && <span className={`flex-none text-[10.5px] ${overdueOf(item) ? 'font-medium text-red-600' : 'text-gray-400'}`}>{time}</span>}
      </span>
      <span className="mt-0.5 flex items-baseline gap-1.5 text-[11.5px] text-gray-500">
        <span className="flex-none text-[10px] text-gray-400">{meta.short}</span>
        <span className="truncate">{item.facts?.lastAction || queueSummary(item, kind)}</span>
      </span>
    </button>
  </div>;
}

function DetailField({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return <div className="min-w-0">
    <div className="text-[10.5px] text-gray-400">{label}</div>
    <div className="mt-0.5 truncate text-[12.5px] text-gray-700">{value}</div>
  </div>;
}

function MailDetail({ item }: { item: AssistantReminder }) {
  const facts = item.facts;
  return <div className="flex flex-col gap-4">
    <div className="grid grid-cols-3 gap-3 border-b border-gray-100 pb-4">
      <DetailField label="客户邮箱" value={facts?.senderEmail || '未识别'} />
      <DetailField label="已等待" value={facts?.waitedHours != null ? `${facts.waitedHours} 小时` : '未知'} />
      <DetailField label="最后动作" value={facts?.lastAction} />
    </div>
    <section>
      <h3 className="text-[11px] font-medium text-teal-700">AI 分析</h3>
      <p className="mt-1.5 whitespace-pre-line text-[12.5px] leading-6 text-gray-600">{facts?.analysis || item.detail}</p>
    </section>
    {facts?.mailExcerpt && <section className="border-t border-gray-100 pt-4">
      <h3 className="text-[11px] text-gray-400">邮件摘要</h3>
      <p className="mt-1.5 text-[12.5px] leading-6 text-gray-600">{facts.mailExcerpt}</p>
    </section>}
  </div>;
}

function QuoteDetail({ item, onSelectCandidate }: { item: AssistantReminder; onSelectCandidate?: (candidateId: string) => void }) {
  const facts = item.facts;
  const candidates = facts?.candidates ?? [];
  const baseLabels = new Set(['起运港', '目的港', '柜型']);
  const extraFields = (facts?.fieldSummary ?? []).filter(field => !baseLabels.has(field.label));
  return <div className="flex flex-col gap-5">
    <section className="grid grid-cols-3 gap-x-4 gap-y-3 border-b border-gray-100 pb-4">
      <DetailField label="起运港" value={facts?.pol} />
      <DetailField label="目的港" value={facts?.pod} />
      <DetailField label="船司" value={facts?.carrier} />
      <DetailField label="柜型" value={facts?.containerType} />
      <DetailField label="价格" value={money(facts?.price, facts?.currency)} />
      <DetailField label="有效期" value={facts?.validTo} />
      {extraFields.map(field => <DetailField key={field.label} label={field.label} value={field.value} />)}
    </section>
    <section>
      <div className="flex items-baseline gap-2">
        <h3 className="text-[11px] font-medium text-gray-500">匹配报价</h3>
        <span className="text-[10.5px] text-gray-400">{candidates.length} 条</span>
        <span className="ml-auto text-[10.5px] text-gray-400">来源 {facts?.source || 'Navigator'}</span>
      </div>
      <div className="mt-2 divide-y divide-gray-100 border-y border-gray-100">
        {candidates.length === 0 ? <div className="py-4 text-[11.5px] text-gray-400">暂无其他匹配条目</div>
          : candidates.map(candidate => {
            const selected = candidate.id === facts?.selectedCandidateId;
            return <div key={candidate.id} className="flex items-center gap-3 py-2.5">
              <span className={`flex h-4 w-4 flex-none items-center justify-center rounded-full border ${selected ? 'border-teal-700 bg-teal-700 text-white' : 'border-gray-300 text-transparent'}`}><CheckOutlined className="text-[9px]" /></span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <strong className="truncate text-[12.5px] font-medium text-gray-700">{candidate.carrier || '未标船司'}</strong>
                  <span className="text-[12.5px] font-medium text-teal-700">{money(candidate.price, candidate.currency)}</span>
                </span>
                <span className="mt-0.5 block truncate text-[10.5px] text-gray-400">
                  {[[candidate.pol, candidate.pod].filter(Boolean).join(' -> '), candidate.containerType, candidate.validTo && `有效期 ${candidate.validTo}`].filter(Boolean).join(' · ')}
                </span>
              </span>
              {onSelectCandidate && !selected && <button type="button" onClick={() => onSelectCandidate(candidate.id)}
                className="flex-none rounded border border-teal-200 px-2 py-0.5 text-[10.5px] text-teal-700 hover:bg-teal-50">选这条</button>}
              {selected && <span className="flex-none text-[10.5px] text-teal-700">已选</span>}
            </div>;
          })}
      </div>
    </section>
    <section className="border-t border-gray-100 pt-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-[11px] text-gray-400">邮件原文</h3>
        {facts?.subject && <strong className="text-[12.5px] font-medium text-gray-700">{facts.subject}</strong>}
        {facts?.customerEmail && <span className="text-[10.5px] text-gray-400">{facts.customerEmail}</span>}
      </div>
      {facts?.mailExcerpt && <p className="mt-1.5 text-[12.5px] leading-6 text-gray-600">{facts.mailExcerpt}</p>}
    </section>
  </div>;
}

function BatchDetail({ item, onOpenTarget }: { item: AssistantReminder; onOpenTarget?: (target: string) => void }) {
  const items = item.facts?.items ?? [];
  if (!items.length) return <p className="text-[12px] text-gray-400">{item.detail}</p>;
  return <div className="divide-y divide-gray-100 border-y border-gray-100">
    {items.map(entry => <button key={entry.id} type="button" onClick={() => onOpenTarget?.(entry.target)}
      className="group flex w-full items-center gap-3 py-3 text-left">
      <span className="min-w-0 flex-1">
        <strong className="block truncate text-[12.5px] font-medium text-gray-700">{entry.title}</strong>
        <small className="mt-0.5 block truncate text-[11px] text-gray-400">{entry.detail}</small>
      </span>
      {entry.meta && <span className="flex-none text-[10.5px] text-amber-600">{entry.meta}</span>}
      <RightOutlined className="flex-none text-[10px] text-gray-300 group-hover:text-teal-600" />
    </button>)}
  </div>;
}

function EmptyDetail() {
  return <div className="flex h-full flex-col items-center justify-center gap-2 text-gray-300">
    <InboxOutlined className="text-[28px]" />
    <span className="text-[12px]">选择一条任务查看详情</span>
  </div>;
}

export function AssistantTaskWorkspace({ items, busy, onOpen, onDismiss, onOpenTarget, onSelectCandidate, onComplete }: {
  items: readonly AssistantReminder[];
  busy?: boolean;
  onOpen: (item: AssistantReminder) => void;
  onDismiss: (item: AssistantReminder) => void;
  onOpenTarget: (target: string) => void;
  onSelectCandidate: (item: AssistantReminder, candidateId: string) => void;
  onComplete: (item: AssistantReminder) => void;
}) {
  const [filter, setFilter] = useState<'all' | ReminderKind>('all');
  const [keyword, setKeyword] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [doneIds, setDoneIds] = useState<string[]>([]);
  const allRows = useMemo(() => {
    const seen = new Set<string>();
    return items.filter(item => {
      const key = item.facts?.messageId != null ? `message:${item.facts.messageId}` : item.target;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [items]);
  const counts = useMemo(() => {
    const base = { all: allRows.length, mail: 0, quote: 0, task: 0, followup: 0 };
    for (const item of items) base[reminderKind(item)] += 1;
    return base;
  }, [items, allRows]);
  const visible = useMemo(() => {
    const text = keyword.trim().toLowerCase();
    const scope = filter === 'all' ? allRows : items.filter(item => reminderKind(item) === filter);
    return scope.filter(item => {
      if (!text) return true;
      return `${item.title} ${item.detail} ${item.facts?.customerName ?? ''} ${item.facts?.subject ?? ''} ${item.facts?.senderEmail ?? ''}`.toLowerCase().includes(text);
    });
  }, [items, allRows, filter, keyword]);
  const groups = useMemo(() => {
    const order = (left: AssistantReminder, right: AssistantReminder) =>
      left.priority - right.priority || timeKey(left) - timeKey(right);
    const overdue = visible.filter(item => overdueOf(item)).sort(order);
    const today = visible.filter(item => !overdueOf(item)).sort(order);
    return [
      { key: 'overdue', label: '逾期未处理', items: overdue },
      { key: 'today', label: '今天', items: today },
    ].filter(group => group.items.length > 0);
  }, [visible]);
  const overdueTotal = useMemo(() => allRows.filter(item => overdueOf(item)).length, [allRows]);
  const selected = visible.find(item => item.reminderId === selectedId) ?? visible[0] ?? null;
  const kind = selected ? reminderKind(selected) : null;
  const meta = kind ? KIND_META[kind] : null;
  const Icon = meta?.icon;
  const complete = (item: AssistantReminder) => {
    if (doneIds.includes(item.reminderId)) return;
    setDoneIds(current => [...current, item.reminderId]);
    onComplete(item);
  };
  const detailTitle = selected ? (kind === 'mail' ? selected.facts?.subject || selected.title
    : kind === 'quote' ? [lane(selected.facts), selected.facts?.containerType].filter(Boolean).join(' · ') || selected.title
      : selected.title) : '';
  const detailSubtitle = selected ? (kind === 'mail'
    ? selected.facts?.customerName || selected.detail
    : kind === 'quote'
      ? [selected.facts?.customerName, selected.facts?.carrier, money(selected.facts?.price, selected.facts?.currency)].filter(Boolean).join(' · ') || selected.detail
      : selected.detail) : '';

  return <div className="grid min-h-0 flex-1 grid-cols-[360px_minmax(0,1fr)] overflow-hidden bg-white max-[1180px]:grid-cols-[320px_minmax(0,1fr)]">
    <aside className="flex min-h-0 flex-col border-r border-gray-200" aria-label="任务队列">
      <div className="flex flex-col gap-2 border-b border-gray-200 px-3 pb-2.5 pt-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[15px] font-semibold text-gray-900">待处理 {allRows.length} 件</h2>
          {overdueTotal > 0 && <span className="text-[11px] font-medium text-red-600">逾期 {overdueTotal}</span>}
          <span className="ml-auto text-[11px] text-gray-400">{dayLabel()}</span>
        </div>
        <div className="grid grid-cols-5 gap-1" role="tablist" aria-label="任务分类">
          {FILTERS.map(option => <button key={option.value} type="button" role="tab" aria-selected={filter === option.value}
            onClick={() => setFilter(option.value)}
            className={`flex min-w-0 items-center justify-center gap-1 rounded-md px-1 py-1 text-[11px] transition-colors ${filter === option.value ? 'bg-teal-700 text-white' : 'bg-gray-50 text-gray-600 hover:bg-gray-100'}`}>
            <span className="truncate">{option.label}</span>
            <span className={`text-[9.5px] ${filter === option.value ? 'text-white/70' : 'text-gray-400'}`}>{counts[option.value]}</span>
          </button>)}
        </div>
        <Input size="small" allowClear prefix={<SearchOutlined className="text-gray-300" />} placeholder="搜索事项" value={keyword} onChange={event => setKeyword(event.target.value)} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {visible.length === 0 ? <div className="px-4 py-10 text-center text-[12px] text-gray-400">{items.length ? '没有匹配的事项' : '今天没有待处理事项'}</div>
          : groups.map(group => <section key={group.key} aria-label={group.label}>
            <div className="flex items-center gap-2 bg-gray-50/80 px-3 py-1.5">
              {group.key === 'overdue' && <span className="h-1.5 w-1.5 rounded-full bg-red-500" />}
              <span className={`text-[11px] font-medium ${group.key === 'overdue' ? 'text-red-700' : 'text-gray-500'}`}>{group.label}</span>
              <span className="text-[10.5px] text-gray-400">{group.items.length}</span>
            </div>
            <div className="divide-y divide-gray-100">
              {group.items.map(item => <QueueRow key={item.reminderId} item={item}
                selected={selected?.reminderId === item.reminderId}
                done={doneIds.includes(item.reminderId)}
                onSelect={() => setSelectedId(item.reminderId)}
                onComplete={() => complete(item)} />)}
            </div>
          </section>)}
      </div>
    </aside>
    <section className="flex min-h-0 min-w-0 flex-col" aria-label="任务详情">
      {!selected || !meta || !Icon ? <EmptyDetail /> : <>
        <header className="flex items-start gap-3 border-b border-gray-100 px-5 py-4">
          <span className={`mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-md bg-gray-50 ${meta.iconClass}`}><Icon className="text-[15px]" /></span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[10.5px] text-gray-400">
              <span>{meta.label}</span>
              <span className={selected.priority === 1 ? 'text-red-500' : ''}>{priorityLabel(selected.priority)}</span>
              {queueMeta(selected, reminderKind(selected)) && <><span className="text-gray-300">·</span><span>{queueMeta(selected, reminderKind(selected))}</span></>}
              {busy && <span className="text-teal-600">整理中</span>}
            </div>
            <h2 className="mt-1 text-[16px] font-semibold leading-6 text-gray-800">{detailTitle}</h2>
            <p className="mt-0.5 line-clamp-2 text-[12px] leading-5 text-gray-500">{detailSubtitle}</p>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {kind === 'mail' ? <MailDetail item={selected} />
            : kind === 'quote' ? <QuoteDetail item={selected} onSelectCandidate={candidateId => onSelectCandidate(selected, candidateId)} />
              : <BatchDetail item={selected} onOpenTarget={onOpenTarget} />}
        </div>
        <footer className="flex items-center gap-2 border-t border-gray-100 px-5 py-3">
          <button type="button" onClick={() => kind === 'task' || kind === 'followup' ? onOpenTarget(selected.target) : onOpen(selected)}
            className="rounded-md bg-teal-700 px-3.5 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-teal-800">
            {meta.action}
          </button>
          <div className="ml-auto flex items-center gap-3">
            {selected.facts?.messageId != null && <button type="button" onClick={() => complete(selected)}
              disabled={doneIds.includes(selected.reminderId)}
              className="text-[11px] text-gray-500 transition-colors hover:text-teal-700 disabled:text-gray-300">
              {doneIds.includes(selected.reminderId) ? '已标记完成' : '标记已完成'}
            </button>}
            {!selected.reminderId.startsWith('queue:') && <button type="button" onClick={() => onDismiss(selected)}
              className="text-[11px] text-gray-400 transition-colors hover:text-gray-600">稍后</button>}
          </div>
        </footer>
      </>}
    </section>
  </div>;
}
