import { useState } from 'react';
import { CheckSquareOutlined, ClockCircleOutlined, DownOutlined, FileDoneOutlined, MailOutlined, RightOutlined } from '@ant-design/icons';
import type { AssistantReminder, AssistantReminderFacts, AssistantReminderKind } from '../../shared/assistant';

export type ReminderKind = AssistantReminderKind;

const KIND_META: Record<ReminderKind, { label: string; action: string; icon: typeof MailOutlined; iconClass: string }> = {
  mail: { label: '客户回复', action: '去回复', icon: MailOutlined, iconClass: 'text-teal-600' },
  quote: { label: '报价确认', action: '去回复', icon: FileDoneOutlined, iconClass: 'text-amber-600' },
  task: { label: '到期待办', action: '查看待办', icon: CheckSquareOutlined, iconClass: 'text-sky-600' },
  followup: { label: '停滞跟进', action: '查看客户', icon: ClockCircleOutlined, iconClass: 'text-slate-500' },
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
  return [facts?.pol, facts?.pod].filter(Boolean).join(' → ');
}

function FactsLine({ facts }: { facts?: AssistantReminderFacts }) {
  const fields = facts?.fieldSummary ?? [];
  if (!fields.length) return null;
  return <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-gray-500">
    {fields.slice(0, 5).map(field => <span key={field.label}><span className="text-gray-400">{field.label}</span> {field.value}</span>)}
  </div>;
}

function MailMain({ item, facts }: { item: AssistantReminder; facts?: AssistantReminderFacts }) {
  return <>
    <h3 className="text-[14px] font-medium leading-6 text-gray-800">{facts?.subject || item.title}</h3>
    <p className="mt-1 truncate text-[12px] text-gray-500">{facts?.senderEmail || '客户邮箱未识别'}</p>
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-gray-500">
      <span>{facts?.waitedHours != null ? `已等 ${facts.waitedHours} 小时` : '等待时长未知'}</span>
      {facts?.lastAction && <><span className="text-gray-300">·</span><span>{facts.lastAction}</span></>}
    </div>
  </>;
}

function QuoteMain({ item, facts }: { item: AssistantReminder; facts?: AssistantReminderFacts }) {
  const customer = facts?.customerName || item.title.replace(/^.*?：/, '');
  const price = money(facts?.price, facts?.currency);
  return <>
    <div className="flex items-baseline gap-2">
      <h3 className="min-w-0 truncate text-[14px] font-medium leading-6 text-gray-800">{customer}</h3>
      {facts?.customerEmail && <span className="truncate text-[11px] text-gray-400">{facts.customerEmail}</span>}
    </div>
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-gray-600">
      {lane(facts) && <span className="font-medium text-gray-700">{lane(facts)}</span>}
      {facts?.carrier && <span>{facts.carrier}</span>}
      {facts?.containerType && <span>{facts.containerType}</span>}
      {price && <span className="font-medium text-teal-700">{price}</span>}
      {facts?.validTo && <span className="text-[11px] text-gray-400">有效期 {facts.validTo}</span>}
    </div>
    <FactsLine facts={facts} />
  </>;
}

function BatchMain({ item, facts }: { item: AssistantReminder; facts?: AssistantReminderFacts }) {
  return <>
    <h3 className="text-[14px] font-medium leading-6 text-gray-800">{item.title}</h3>
    <p className="mt-1 text-[12px] text-gray-500">{item.detail}</p>
    {!!facts?.items?.length && <p className="mt-1 text-[11px] text-gray-400">点击展开查看全部 {facts.total ?? facts.items.length} 条</p>}
  </>;
}

function MailExpanded({ item, facts, onOpen }: { item: AssistantReminder; facts?: AssistantReminderFacts; onOpen: () => void }) {
  return <div className="flex flex-col gap-2">
    <div className="rounded-md bg-teal-50/60 px-3 py-2.5">
      <div className="text-[11px] font-medium text-teal-700">AI 分析</div>
      <p className="mt-1 whitespace-pre-line text-[12px] leading-5 text-gray-600">{facts?.analysis || item.detail}</p>
    </div>
    {facts?.mailExcerpt && <div className="rounded-md border border-gray-200 px-3 py-2.5">
      <div className="text-[11px] text-gray-400">邮件摘要</div>
      <p className="mt-1 line-clamp-4 text-[12px] leading-5 text-gray-600">{facts.mailExcerpt}</p>
      <button type="button" className="mt-2 text-[11px] text-teal-700 hover:text-teal-800" onClick={onOpen}>打开完整邮件</button>
    </div>}
  </div>;
}

function QuoteExpanded({ facts, onOpen, onSelectCandidate }: {
  facts?: AssistantReminderFacts;
  onOpen: () => void;
  onSelectCandidate?: (candidateId: string) => void;
}) {
  const others = (facts?.candidates ?? []).filter(candidate => candidate.id !== facts?.selectedCandidateId);
  return <div className="flex flex-col gap-3">
    <div>
      <div className="mb-2 text-[11px] text-gray-400">其他匹配条目</div>
      {others.length === 0 ? <div className="rounded-md border border-dashed border-gray-200 px-3 py-3 text-[11px] text-gray-400">暂无其他匹配条目</div>
        : <div className="grid grid-cols-2 gap-2">
          {others.map(candidate => <div key={candidate.id} className="rounded-md border border-gray-200 bg-white px-3 py-2.5">
            <div className="flex items-baseline gap-2">
              <strong className="min-w-0 flex-1 truncate text-[12px] text-gray-700">{candidate.carrier || '未标船司'}</strong>
              <span className="text-[12px] font-medium text-teal-700">{money(candidate.price, candidate.currency)}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-gray-500">
              {[candidate.pol, candidate.pod].filter(Boolean).join(' → ') && <span>{[candidate.pol, candidate.pod].filter(Boolean).join(' → ')}</span>}
              {candidate.containerType && <span>{candidate.containerType}</span>}
              {candidate.validTo && <span>有效期 {candidate.validTo}</span>}
            </div>
            {onSelectCandidate && <button type="button" className="mt-2 rounded border border-teal-200 px-2 py-0.5 text-[11px] text-teal-700 hover:bg-teal-50" onClick={() => onSelectCandidate(candidate.id)}>选这条</button>}
          </div>)}
        </div>}
    </div>
    <div className="rounded-md border border-gray-200 px-3 py-2.5">
      <div className="text-[11px] text-gray-400">邮件原文</div>
      <div className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-gray-500">
        {facts?.subject && <strong className="text-[12px] font-medium text-gray-700">{facts.subject}</strong>}
        {facts?.customerEmail && <span>{facts.customerEmail}</span>}
      </div>
      {facts?.mailExcerpt && <p className="mt-1 line-clamp-4 text-[12px] leading-5 text-gray-600">{facts.mailExcerpt}</p>}
      <button type="button" className="mt-2 text-[11px] text-teal-700 hover:text-teal-800" onClick={onOpen}>打开完整邮件</button>
    </div>
  </div>;
}

function BatchExpanded({ facts, onOpenTarget }: { facts?: AssistantReminderFacts; onOpenTarget?: (target: string) => void }) {
  const items = facts?.items ?? [];
  if (!items.length) return <div className="text-[11px] text-gray-400">没有可展开的条目。</div>;
  return <div className="flex flex-col gap-1.5">
    {items.map(item => <button key={item.id} type="button" onClick={() => onOpenTarget?.(item.target)}
      className="group flex items-center gap-2 rounded-md border border-gray-200 px-3 py-2 text-left hover:border-gray-300">
      <span className="min-w-0 flex-1">
        <strong className="block truncate text-[12px] font-medium text-gray-700">{item.title}</strong>
        <small className="block truncate text-[11px] text-gray-400">{item.detail}</small>
      </span>
      {item.meta && <span className="flex-none text-[10px] text-amber-600">{item.meta}</span>}
      <RightOutlined className="text-[10px] text-gray-300 group-hover:text-teal-600" />
    </button>)}
  </div>;
}

export function AssistantActionCard({ item, onOpen, onAsk, onDismiss, onOpenTarget, onSelectCandidate }: {
  item: AssistantReminder;
  onOpen: () => void;
  onAsk?: () => void;
  onDismiss?: () => void;
  onOpenTarget?: (target: string) => void;
  onSelectCandidate?: (candidateId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const kind = reminderKind(item);
  const meta = KIND_META[kind];
  const Icon = meta.icon;
  const facts = item.facts;
  const priority = item.priority === 1 ? '最优先' : item.priority === 2 ? '优先' : '留意';
  const batch = kind === 'task' || kind === 'followup';
  const toggle = () => setExpanded(value => !value);
  return <article className="overflow-hidden rounded-lg border border-gray-200 bg-white">
    <div className="flex items-center gap-2 px-4 pt-3 text-[11px] text-gray-400">
      <Icon className={`text-[12px] ${meta.iconClass}`} />
      <span>{meta.label}</span>
      <span className={`ml-auto ${item.priority === 1 ? 'text-red-500' : 'text-gray-400'}`}>{priority}</span>
      <button type="button" aria-label={expanded ? '收起详情' : '展开详情'} title={expanded ? '收起详情' : '展开详情'} onClick={toggle}
        className="flex h-5 w-5 items-center justify-center rounded text-gray-300 hover:bg-gray-100 hover:text-teal-700"><DownOutlined className={`text-[10px] transition-transform ${expanded ? 'rotate-180' : ''}`} /></button>
    </div>
    <div className="cursor-pointer px-4 py-2.5" onClick={toggle}>
      {kind === 'mail' ? <MailMain item={item} facts={facts} /> : kind === 'quote' ? <QuoteMain item={item} facts={facts} /> : <BatchMain item={item} facts={facts} />}
    </div>
    {expanded && <div className="border-t border-gray-100 px-4 py-3">
      {kind === 'mail' ? <MailExpanded item={item} facts={facts} onOpen={onOpen} />
        : kind === 'quote' ? <QuoteExpanded facts={facts} onOpen={onOpen} onSelectCandidate={onSelectCandidate} />
          : <BatchExpanded facts={facts} onOpenTarget={onOpenTarget} />}
    </div>}
    <div className="flex items-center gap-2 px-4 pb-3 pt-1">
      <button type="button" onClick={batch ? toggle : onOpen}
        className="rounded-md bg-teal-700 px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-teal-800">
        {batch ? `${expanded ? '收起' : '查看'} ${facts?.total ?? facts?.items?.length ?? ''} 项` : meta.action}
      </button>
      {onAsk && <button type="button" onClick={onAsk}
        className="rounded-md border border-gray-200 px-3 py-1.5 text-[12px] text-gray-600 transition-colors hover:border-teal-300 hover:text-teal-700">让助手帮我</button>}
      {onDismiss && <button type="button" onClick={onDismiss}
        className="ml-auto text-[11px] text-gray-300 transition-colors hover:text-gray-500">稍后</button>}
    </div>
  </article>;
}

export function AssistantAttentionRow({ item, onOpen }: { item: AssistantReminder; onOpen: () => void }) {
  const meta = KIND_META[reminderKind(item)];
  const Icon = meta.icon;
  return <button type="button" onClick={onOpen}
    className="group flex items-center gap-3 rounded-lg border border-gray-200 bg-white px-3.5 py-2.5 text-left transition-colors hover:border-gray-300">
    <Icon className={`text-[12px] ${meta.iconClass}`} />
    <span className="min-w-0 flex-1">
      <strong className="block truncate text-[12.5px] font-medium text-gray-700">{item.title}</strong>
      <small className="block truncate text-[11px] text-gray-400">{item.detail}</small>
    </span>
    <RightOutlined className="text-[10px] text-gray-300 transition-colors group-hover:text-teal-600" />
  </button>;
}

const ATTENTION_VISIBLE = 4;

export function AssistantAttentionList({ items, onOpen }: { items: readonly AssistantReminder[]; onOpen: (item: AssistantReminder) => void }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? items : items.slice(0, ATTENTION_VISIBLE);
  const hidden = items.length - visible.length;
  return <section aria-label="需要注意">
    <div className="px-1 text-[11px] text-gray-400">需要注意</div>
    <div className="mt-2 flex flex-col gap-2">
      {visible.map(item => <AssistantAttentionRow key={item.reminderId} item={item} onOpen={() => onOpen(item)} />)}
      {hidden > 0 && <button type="button" onClick={() => setExpanded(true)}
        className="px-1 text-left text-[11px] text-gray-400 transition-colors hover:text-teal-700">展开其余 {hidden} 件</button>}
      {expanded && items.length > ATTENTION_VISIBLE && <button type="button" onClick={() => setExpanded(false)}
        className="px-1 text-left text-[11px] text-gray-400 transition-colors hover:text-teal-700">收起</button>}
    </div>
  </section>;
}
