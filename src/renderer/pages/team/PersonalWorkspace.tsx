import { useEffect, useState } from 'react';
import { CalendarClock, ChevronRight, Clock3, ListTodo, Reply, UsersRound } from 'lucide-react';
import { attentionDueLabel, CONTACT_TOUCH_LABELS, CUSTOMER_ATTENTION_URGENCY_PRIORITY, ONLINE_LIMITS, customerAttentionUrgency, isBoardActiveRelationshipStage, type CenterContact, type CustomerAttentionUrgency, type CustomerBoardAttentionReason, type FollowupTask } from '../../../shared/online-crm';
import type { TeamContactScope } from '../../../shared/team-workspace';
import { CRM_STAGES } from '../../components/ContactDetail';
import { useVisiblePolling } from '../../hooks/useVisiblePolling';
import { useTeamContactPage, useTeamOpenTasks } from './team-data';
import { QuoteReviewQueue } from './QuoteReviewQueue';
import './personal-workspace.css';

const dateTime = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const ACTION_CONTACT_PAGE_SIZE = 100;
const ACTION_TASK_PAGE_SIZE = 20;

type ActionFilter = 'all' | CustomerBoardAttentionReason;

const ATTENTION_LABELS: Record<CustomerBoardAttentionReason, string> = {
  reply: '客户回复',
  task: '有任务客户',
  stage: '业务阶段',
};
const ATTENTION_FILTERS: ReadonlyArray<{ key: ActionFilter; label: string; icon: typeof ListTodo }> = [
  { key: 'all', label: '全部关注', icon: ListTodo },
  { key: 'reply', label: ATTENTION_LABELS.reply, icon: Reply },
  { key: 'task', label: ATTENTION_LABELS.task, icon: CalendarClock },
  { key: 'stage', label: ATTENTION_LABELS.stage, icon: ChevronRight },
];

interface ActionContact {
  contact: CenterContact;
  scope: TeamContactScope;
  reason?: CustomerBoardAttentionReason;
  urgency?: CustomerAttentionUrgency;
}

function when(value: string | null | undefined): string {
  if (!value) return '暂无往来';
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? dateTime.format(parsed) : value;
}

function contactName(contact: CenterContact): string {
  return [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.email?.split('@')[0] || '未命名联系人';
}

function attentionReason(contact: CenterContact): CustomerBoardAttentionReason | undefined {
  if (contact.attentionReason) return contact.attentionReason;
  if (contact.touchStatus === 'replied') return 'reply';
  if (isBoardActiveRelationshipStage(contact.relationshipStage)) return 'stage';
  return undefined;
}

function attentionUrgency(contact: CenterContact, now: Date): CustomerAttentionUrgency | undefined {
  return customerAttentionUrgency({ attentionReason: attentionReason(contact), attentionDueAt: contact.attentionDueAt }, now);
}

function actionLabel(item: ActionContact): string {
  if (item.reason === 'reply') return '回复客户';
  if (item.reason === 'task') return '处理待办';
  if (item.reason === 'stage') return '推进阶段';
  const contact = item.contact;
  if (contact.touchStatus === 'bounced') return '核对邮箱';
  if (contact.touchStatus === 'replied') return '继续推进';
  if (contact.touchStatus === 'uncontacted') return '开始跟进';
  return '继续跟进';
}

function elapsedLabel(value: string | null | undefined): string {
  const parsed = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return '未记录';
  const days = Math.max(0, Math.floor((Date.now() - parsed) / 86_400_000));
  if (days === 0) return '今天';
  if (days === 1) return '1 天';
  return `${days} 天`;
}

function stageLabel(value: string | null | undefined): string {
  if (!value) return '未设置';
  return CRM_STAGES.find(stage => stage.key === value)?.label || value;
}

function progressHint(item: ActionContact, taskCount: number): string {
  if (item.reason === 'reply') return taskCount ? '优先完成跟进任务并回复' : '客户已回信，安排下一次跟进';
  if (item.reason === 'task') return '按跟进任务推进下一次联系';
  if (item.reason === 'stage') return `围绕${stageLabel(item.contact.relationshipStage)}推进下一步`;
  if (item.contact.touchStatus === 'bounced') return '先核对邮箱，暂停继续发送';
  if (item.contact.touchStatus === 'uncontacted') return taskCount ? '完成首次触达待办' : '补齐联系方式后开始触达';
  return taskCount ? '按跟进任务推进下一次联系' : '确认客户阶段后安排跟进';
}

function customerHref(contact: CenterContact): string {
  const params = new URLSearchParams({ view: 'table', centerContact: String(contact.contactId), centerCustomer: contact.customerId });
  return `#/customers?${params.toString()}`;
}

function actionKey(item: ActionContact): string {
  return `${item.scope}:${item.contact.customerId}:${item.contact.contactId}`;
}

function resultMessage(result: { ok: boolean; error?: { message: string } } | undefined): string {
  return result && !result.ok ? result.error?.message || '中心数据读取失败' : '';
}

function TaskList({ tasks, total, error, title, empty }: { tasks: readonly FollowupTask[]; total: number; error: string; title: string; empty: string }) {
  return <section className="personal-task-panel" aria-label="我的待办">
    <div className="personal-panel-heading"><div><h2>{title}</h2><span>最近开放</span></div><span>{total} 项</span></div>
    {error ? <div className="personal-panel-state is-error">{error}</div> : tasks.length === 0 ? <div className="personal-panel-state">{empty}</div> : <div className="personal-task-list">{tasks.map(task => <article key={task.taskId} className="personal-task-row"><span className="personal-task-dot"><Clock3 aria-hidden="true" /></span><div><strong>{task.title}</strong><small>{when(task.dueAt)}</small></div></article>)}</div>}
  </section>;
}

function ActionContext({ item, taskCount, now }: { item: ActionContact | null; taskCount: number; now: Date }) {
  if (!item) return <section className="personal-context-panel personal-context-empty"><div className="personal-panel-state">选择一条行动查看详情</div></section>;
  const { contact, scope } = item;
  const dueLabel = attentionDueLabel(contact.attentionDueAt, now);
  return <section className="personal-context-panel" aria-label="当前客户上下文">
    <div className="personal-context-summary">
      <span className={`personal-context-avatar is-${contact.touchStatus}`}>{contactName(contact).slice(0, 1).toUpperCase()}</span>
      <span><strong>{contactName(contact)}</strong><small>{contact.companyName || '未填写公司'} · {scope === 'personal' ? '我的线索' : '分配线索'}</small></span>
    </div>
    <div className="personal-context-tags">
      {item.reason
        ? <span className={`personal-attention-reason is-${item.reason}`}>{ATTENTION_LABELS[item.reason]}</span>
        : <span className={`personal-contact-status is-${contact.touchStatus}`}>{CONTACT_TOUCH_LABELS[contact.touchStatus]}</span>}
      {dueLabel && <span className={`personal-attention-due${item.urgency ? ` is-${item.urgency}` : ''}`}>{dueLabel}</span>}
      {contact.relationshipStage && <span>{stageLabel(contact.relationshipStage)}</span>}
      {contact.country && <span>{contact.country}</span>}
    </div>
    <div className="personal-context-action">
      <span>下一步</span><strong>{actionLabel(item)}</strong><small>{dueLabel ? `${dueLabel} · ` : ''}最近往来 {when(contact.lastFollowupAt)}</small>
    </div>
    <div className="personal-context-progress" aria-label="推进指标">
      <div><span>关注原因</span><strong>{item.reason ? ATTENTION_LABELS[item.reason] : CONTACT_TOUCH_LABELS[contact.touchStatus]}</strong></div>
      <div><span>开放待办</span><strong>{taskCount} 项</strong></div>
      <div><span>距最近往来</span><strong>{elapsedLabel(contact.lastFollowupAt)}</strong></div>
      <div><span>线索归属</span><strong>{scope === 'personal' ? '我的线索' : '分配线索'}</strong></div>
    </div>
    <div className="personal-context-guidance"><span>推进建议</span><strong>{progressHint(item, taskCount)}</strong></div>
    <dl className="personal-context-facts">
      <div><dt>客户阶段</dt><dd>{stageLabel(contact.relationshipStage)}</dd></div>
      <div><dt>最近往来</dt><dd>{when(contact.lastFollowupAt)}</dd></div>
      {contact.lastFollowupNote && <div className="is-wide"><dt>最近跟进</dt><dd>{contact.lastFollowupNote}</dd></div>}
    </dl>
    <div className="personal-context-actions"><a href={customerHref(contact)}>打开客户 <ChevronRight aria-hidden="true" /></a></div>
  </section>;
}

export function PersonalWorkspace({ includeTasks, search = '', teamName, leaderName, memberCount }: { includeTasks: boolean; search?: string; teamName?: string; leaderName?: string; memberCount?: number }) {
  const [filter, setFilter] = useState<ActionFilter>('all');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const attentionNow = new Date();
  const personal = useTeamContactPage('personal', '', 1, ACTION_CONTACT_PAGE_SIZE, { attentionOnly: true });
  const assigned = useTeamContactPage('assigned', '', 1, ACTION_CONTACT_PAGE_SIZE, { attentionOnly: true });
  const tasks = useTeamOpenTasks(includeTasks, ACTION_TASK_PAGE_SIZE);
  const personalRows = personal.data?.ok ? personal.data.data.items : [];
  const assignedRows = assigned.data?.ok ? assigned.data.data.items : [];
  const taskItems = tasks.data?.ok ? tasks.data.data.items : [];
  const taskTotal = tasks.data?.ok ? tasks.data.data.total : 0;
  const contactError = personal.data && !personal.data.ok && assigned.data && !assigned.data.ok ? resultMessage(personal.data) : '';
  const taskError = includeTasks ? resultMessage(tasks.data) : '';
  const normalizedSearch = search.trim().toLocaleLowerCase('zh-CN');
  const seen = new Set<string>();
  const loadedActions = [...personalRows.map(contact => ({ contact, scope: 'personal' as const, reason: attentionReason(contact), urgency: attentionUrgency(contact, attentionNow) })), ...assignedRows.map(contact => ({ contact, scope: 'assigned' as const, reason: attentionReason(contact), urgency: attentionUrgency(contact, attentionNow) }))]
    .filter(item => {
      const key = `${item.contact.customerId}:${item.contact.contactId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => (left.urgency ? CUSTOMER_ATTENTION_URGENCY_PRIORITY[left.urgency] : 5) - (right.urgency ? CUSTOMER_ATTENTION_URGENCY_PRIORITY[right.urgency] : 5) || Date.parse(right.contact.lastFollowupAt ?? '') - Date.parse(left.contact.lastFollowupAt ?? '')) satisfies ActionContact[];
  const searchedActions = loadedActions.filter(item => !normalizedSearch || [contactName(item.contact), item.contact.companyName, item.contact.email].filter(Boolean).some(value => value!.toLocaleLowerCase('zh-CN').includes(normalizedSearch)));
  const counts = Object.fromEntries(ATTENTION_FILTERS.map(entry => [entry.key, entry.key === 'all' ? searchedActions.length : searchedActions.filter(item => item.reason === entry.key).length])) as Record<ActionFilter, number>;
  const actions = filter === 'all' ? searchedActions : searchedActions.filter(item => item.reason === filter);
  const actionGroups = [
    { key: 'overdue', label: '已逾期', items: actions.filter(item => item.urgency === 'overdue') },
    { key: 'today', label: '今天优先', items: actions.filter(item => item.urgency === 'reply' || item.urgency === 'due_today') },
    { key: 'upcoming', label: '接下来', items: actions.filter(item => item.urgency === 'upcoming_task') },
    { key: 'stage', label: '推进阶段', items: actions.filter(item => item.urgency === 'stage') },
    { key: 'fallback', label: '其他关注', items: actions.filter(item => !item.urgency) },
  ].filter(group => group.items.length > 0);
  const selected = actions.find(item => actionKey(item) === selectedKey) ?? actions[0] ?? null;
  const visibleTasks = normalizedSearch ? taskItems.filter(task => task.title.toLocaleLowerCase('zh-CN').includes(normalizedSearch)) : taskItems;
  const selectedTasks = selected ? visibleTasks.filter(task => task.customerId === selected.contact.customerId) : [];
  useEffect(() => {
    if (!selected) {
      if (selectedKey !== null) setSelectedKey(null);
      return;
    }
    const nextKey = actionKey(selected);
    if (nextKey !== selectedKey) setSelectedKey(nextKey);
  }, [actions, selected, selectedKey]);
  const refresh = async () => {
    await Promise.all([personal.refetch(), assigned.refetch(), ...(includeTasks ? [tasks.refetch()] : [])]);
  };
  useVisiblePolling(refresh, ONLINE_LIMITS.pollMs);
  const loading = personal.isLoading && assigned.isLoading;
  const selectTask = (task: FollowupTask) => {
    const target = actions.find(item => item.contact.customerId === task.customerId);
    if (!target) return;
    setFilter('all');
    setSelectedKey(actionKey(target));
  };

  return <div className={`personal-workspace-body${includeTasks ? ' has-tasks' : ''}`}>
    <aside className="personal-queue-panel" aria-label="行动队列">
      <div className="personal-queue-list">
        <span className="personal-queue-section-title">今天</span>
        {ATTENTION_FILTERS.map(entry => {
          const Icon = entry.icon;
          return <button key={entry.key} type="button" aria-pressed={filter === entry.key} onClick={() => setFilter(entry.key)}>
            <Icon aria-hidden="true" /><span>{entry.label}</span><em>{counts[entry.key]}</em>
          </button>;
        })}
        {includeTasks && <>
          <span className="personal-queue-section-title">总待办</span>
          <div className="personal-queue-todo-summary"><CalendarClock aria-hidden="true" /><span>全部开放待办</span><em>{taskTotal}</em></div>
          <div className="personal-queue-todo-list">
            {visibleTasks.length === 0 ? <span className="personal-queue-todo-empty">{taskError || '暂无待办'}</span> : visibleTasks.map(task => {
              const target = actions.find(item => item.contact.customerId === task.customerId);
              return <button key={task.taskId} type="button" className={target ? 'is-actionable' : ''} aria-disabled={!target} title={target ? `定位到 ${target.contact.companyName}` : '该客户不在当前行动列表'} onClick={() => selectTask(task)}>
                <Clock3 aria-hidden="true" /><span><strong>{task.title}</strong><small>{when(task.dueAt)}</small></span>
              </button>;
            })}
          </div>
        </>}
      </div>
    </aside>
    <main className="personal-actions-panel personal-main-panel">
      <div className="personal-workspace-hero"><div><h1>今天先处理这些</h1><p>{teamName ? `${teamName} · ` : ''}{actions.length} 个行动 · {counts.reply} 个客户回复{includeTasks ? ` · ${taskTotal} 个开放待办` : ''}</p></div></div>
      <section className="personal-overview" aria-label="工作台概览">
        <div className="personal-metrics">
          <div><span>客户回复</span><strong>{counts.reply}</strong><em>今天优先</em></div>
          <div><span>开放待办</span><strong>{taskTotal}</strong><em>全部任务</em></div>
          <div><span>业务阶段</span><strong>{counts.stage}</strong><em>继续推进</em></div>
          <div><span>全部关注</span><strong>{counts.all}</strong><em>当前范围</em></div>
        </div>
      </section>
      <QuoteReviewQueue enabled={includeTasks} />
      <section className="personal-action-content">
      <div className="personal-content-heading"><strong>{filter === 'all' ? '行动队列' : ATTENTION_LABELS[filter]}</strong><span>{actions.length} 项</span></div>
      <div className="personal-action-list" aria-live="polite">
        {contactError ? <div className="personal-panel-state is-error">{contactError}</div>
          : loading ? <div className="personal-panel-state">正在读取中心线索</div>
            : actions.length === 0 ? <div className="personal-panel-state">{normalizedSearch || filter !== 'all' ? '当前筛选没有行动' : '暂无需要立即处理的线索'}</div>
              : actionGroups.map(group => <div key={group.key} className="personal-action-group">
                <div className="personal-action-group-title"><span>{group.label}</span><em>{group.items.length}</em></div>
                {group.items.map(item => { const { contact, scope, reason, urgency } = item, dueLabel = attentionDueLabel(contact.attentionDueAt, attentionNow); return <button key={actionKey(item)} type="button" className={`personal-action-row${selected && actionKey(selected) === actionKey(item) ? ' is-selected' : ''}`} onClick={() => setSelectedKey(actionKey(item))}>
                  <span className="personal-action-main"><span><strong>{contactName(contact)}</strong><small>{contact.companyName || '未填写公司'} · {scope === 'personal' ? '我的线索' : '分配线索'}</small></span><span className="personal-action-meta">{reason ? <span className={`personal-attention-reason is-${reason}`}>{ATTENTION_LABELS[reason]}</span> : <span className={`personal-contact-status is-${contact.touchStatus}`}>{CONTACT_TOUCH_LABELS[contact.touchStatus]}</span>}{dueLabel ? <span className={`personal-attention-due${urgency ? ` is-${urgency}` : ''}`}>{dueLabel}</span> : null}<small>{when(contact.lastFollowupAt)}</small></span></span>
                  <span className="personal-action-next"><strong>{actionLabel(item)}</strong></span>
                  <ChevronRight aria-hidden="true" />
                </button>; })}
              </div>)}
      </div>
      </section>
    </main>
    <aside className="personal-side">
      <ActionContext item={selected} taskCount={selectedTasks.length} now={attentionNow} />
      {includeTasks && <TaskList tasks={selectedTasks} total={selectedTasks.length} error={selected ? taskError : ''} title="跟进任务" empty={selected ? '该客户暂无跟进任务' : '选择客户查看跟进任务'} />}
      {teamName && <section className="personal-team-panel" aria-label="我的团队"><div className="personal-panel-heading"><div><span>团队</span><h2>我的团队</h2></div></div><div className="personal-team-body"><span className="personal-team-avatar"><UsersRound aria-hidden="true" /></span><span><strong>{teamName}</strong><small>主管 {leaderName || '未设置'} · {memberCount ?? 0} 位成员</small></span></div><div className="personal-team-structure"><span>主管 <b>{leaderName || '未设置'}</b></span><span>组员 <b>{Math.max(0, (memberCount ?? 0) - 1)} 人</b></span></div></section>}
    </aside>
  </div>;
}
