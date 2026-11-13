import { ChevronRight, Clock3, UsersRound } from 'lucide-react';
import { CONTACT_TOUCH_LABELS, ONLINE_LIMITS, type CenterContact, type FollowupTask } from '../../../shared/online-crm';
import type { TeamContactScope } from '../../../shared/team-workspace';
import { useVisiblePolling } from '../../hooks/useVisiblePolling';
import { TEAM_DATA_LIMITS, useTeamContactPage, useTeamOpenTasks } from './team-data';
import './personal-workspace.css';

const dateTime = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const ACTIONABLE_STATES = ['bounced', 'replied', 'uncontacted', 'contacted'] as const;
const ACTION_PRIORITY: Record<(typeof ACTIONABLE_STATES)[number], number> = { bounced: 0, replied: 1, uncontacted: 2, contacted: 3 };

interface ActionContact {
  contact: CenterContact;
  scope: TeamContactScope;
}

function when(value: string | null | undefined): string {
  if (!value) return '暂无往来';
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? dateTime.format(parsed) : value;
}

function contactName(contact: CenterContact): string {
  return [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.email?.split('@')[0] || '未命名联系人';
}

function actionLabel(contact: CenterContact): string {
  if (contact.touchStatus === 'bounced') return '核对邮箱';
  if (contact.touchStatus === 'replied') return '继续推进';
  if (contact.touchStatus === 'uncontacted') return '开始跟进';
  return '继续跟进';
}

function customerHref(contact: CenterContact): string {
  const params = new URLSearchParams({ view: 'table', centerContact: String(contact.contactId), centerCustomer: contact.customerId });
  return `#/customers?${params.toString()}`;
}

function resultMessage(result: { ok: boolean; error?: { message: string } } | undefined): string {
  return result && !result.ok ? result.error?.message || '中心数据读取失败' : '';
}

function TaskList({ tasks, total, error }: { tasks: readonly FollowupTask[]; total: number; error: string }) {
  return <section className="personal-task-panel" aria-label="我的待办">
    <div className="personal-panel-heading"><div><h2>待办</h2><span>最近开放</span></div><span>{total} 项</span></div>
    {error ? <div className="personal-panel-state is-error">{error}</div> : tasks.length === 0 ? <div className="personal-panel-state">暂无待办</div> : <div className="personal-task-list">{tasks.map(task => <article key={task.taskId} className="personal-task-row"><span className="personal-task-dot"><Clock3 aria-hidden="true" /></span><div><strong>{task.title}</strong><small>{when(task.dueAt)}</small></div></article>)}</div>}
  </section>;
}

export function PersonalWorkspace({ includeTasks, search = '', teamName, leaderName, memberCount }: { includeTasks: boolean; search?: string; teamName?: string; leaderName?: string; memberCount?: number }) {
  const personal = useTeamContactPage('personal', '', 1, TEAM_DATA_LIMITS.summaryContactPage);
  const assigned = useTeamContactPage('assigned', '', 1, TEAM_DATA_LIMITS.summaryContactPage);
  const tasks = useTeamOpenTasks(includeTasks, TEAM_DATA_LIMITS.summaryTaskPage);
  const personalRows = personal.data?.ok ? personal.data.data.items : [];
  const assignedRows = assigned.data?.ok ? assigned.data.data.items : [];
  const personalTotal = personal.data?.ok ? personal.data.data.total : null;
  const assignedTotal = assigned.data?.ok ? assigned.data.data.total : null;
  const taskItems = tasks.data?.ok ? tasks.data.data.items : [];
  const taskTotal = tasks.data?.ok ? tasks.data.data.total : 0;
  const contactError = personal.data && !personal.data.ok && assigned.data && !assigned.data.ok ? resultMessage(personal.data) : '';
  const taskError = includeTasks ? resultMessage(tasks.data) : '';
  const normalizedSearch = search.trim().toLocaleLowerCase('zh-CN');
  const seen = new Set<string>();
  const actions = [...personalRows.map(contact => ({ contact, scope: 'personal' as const })), ...assignedRows.map(contact => ({ contact, scope: 'assigned' as const }))]
    .filter(item => ACTIONABLE_STATES.includes(item.contact.touchStatus as (typeof ACTIONABLE_STATES)[number]))
    .filter(item => {
      const key = `${item.contact.customerId}:${item.contact.contactId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .filter(item => !normalizedSearch || [contactName(item.contact), item.contact.companyName, item.contact.email].filter(Boolean).some(value => value!.toLocaleLowerCase('zh-CN').includes(normalizedSearch)))
    .sort((left, right) => ACTION_PRIORITY[left.contact.touchStatus as keyof typeof ACTION_PRIORITY] - ACTION_PRIORITY[right.contact.touchStatus as keyof typeof ACTION_PRIORITY] || Date.parse(right.contact.lastFollowupAt ?? '') - Date.parse(left.contact.lastFollowupAt ?? ''))
    .slice(0, 6) satisfies ActionContact[];
  const visibleTasks = normalizedSearch ? taskItems.filter(task => task.title.toLocaleLowerCase('zh-CN').includes(normalizedSearch)) : taskItems;
  const refresh = async () => {
    await Promise.all([personal.refetch(), assigned.refetch(), ...(includeTasks ? [tasks.refetch()] : [])]);
  };
  useVisiblePolling(refresh, ONLINE_LIMITS.pollMs);
  const loading = personal.isLoading && assigned.isLoading;

  return <div className={`personal-workspace-body${includeTasks ? ' has-tasks' : ''}`}>
    <main className="personal-actions-panel personal-main-panel">
      <div className="personal-panel-heading personal-workspace-heading"><div><span>个人工作台</span><h2>今天先处理这些</h2></div><span>按优先级排序</span></div>
      <section className="personal-overview" aria-label="工作台概览">
        <div className="personal-overview-actions"><span>行动概览</span><a href="#/customers?view=table">打开客户页 <ChevronRight aria-hidden="true" /></a></div>
        <div className="personal-metrics">
          <div><span>我的线索</span><strong>{personalTotal ?? '—'}</strong><a href="#/customers?view=table">查看</a></div>
          <div><span>分配线索</span><strong>{assignedTotal ?? '—'}</strong><a href="#/customers?view=table">查看</a></div>
          {includeTasks && <div><span>开放待办</span><strong>{tasks.data?.ok ? taskTotal : '—'}</strong><span>仅本人</span></div>}
        </div>
      </section>
      <div className="personal-panel-heading"><div><h2>最近需要处理</h2><span>最多 6 条</span></div><span>进入客户页处理</span></div>
      <div className="personal-action-list" aria-live="polite">
        {contactError ? <div className="personal-panel-state is-error">{contactError}</div>
          : loading ? <div className="personal-panel-state">正在读取中心线索</div>
            : actions.length === 0 ? <div className="personal-panel-state">{normalizedSearch ? '没有匹配的线索' : '暂无需要立即处理的线索'}</div>
              : actions.map(({ contact, scope }) => <a key={`${contact.customerId}:${contact.contactId}`} className="personal-action-row" href={customerHref(contact)}>
                <span className="personal-action-main"><span><strong>{contactName(contact)}</strong><small>{contact.companyName}</small></span><span className={`personal-contact-status is-${contact.touchStatus}`}>{CONTACT_TOUCH_LABELS[contact.touchStatus]}</span></span>
                <span className="personal-action-next"><small>{scope === 'personal' ? '我的线索' : '分配线索'} · {when(contact.lastFollowupAt)}</small><strong>{actionLabel(contact)}</strong></span>
                <ChevronRight aria-hidden="true" />
              </a>)}
      </div>
    </main>
    <aside className="personal-side">
      {includeTasks && <TaskList tasks={visibleTasks} total={normalizedSearch ? visibleTasks.length : taskTotal} error={taskError} />}
      {teamName && <section className="personal-team-panel" aria-label="我的团队"><div className="personal-panel-heading"><div><span>团队</span><h2>我的团队</h2></div></div><div className="personal-team-body"><span className="personal-team-avatar"><UsersRound aria-hidden="true" /></span><span><strong>{teamName}</strong><small>主管 {leaderName || '未设置'} · {memberCount ?? 0} 位成员</small></span></div><div className="personal-team-structure"><span>主管 <b>{leaderName || '未设置'}</b></span><span>组员 <b>{Math.max(0, (memberCount ?? 0) - 1)} 人</b></span></div></section>}
    </aside>
  </div>;
}
