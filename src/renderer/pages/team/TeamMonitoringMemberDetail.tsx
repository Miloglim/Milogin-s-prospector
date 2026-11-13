import { AlertCircle, Clock3, ExternalLink, Mail, Target, UserRound, X } from 'lucide-react';
import { Spin } from 'antd';
import type { TeamMonitoringMailSummary } from '../../../shared/online-crm';
import { useTeamMonitoringMember } from './team-data';

const DETAIL_MAIL_PAGE_SIZE = 10;

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function dateTime(value: string | null): string {
  if (!value) return '暂无';
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function priorityLabel(value: string): string {
  if (value === 'urgent') return '紧急';
  if (value === 'important') return '重要';
  return '普通';
}

export function TeamMonitoringMemberDetail({ userId, online, onClose, onOpenMail, embedded = false }: {
  userId: string;
  online: boolean;
  onClose?: () => void;
  onOpenMail: (mail: TeamMonitoringMailSummary) => void;
  embedded?: boolean;
}) {
  const query = useTeamMonitoringMember(userId, online, DETAIL_MAIL_PAGE_SIZE);
  const detail = query.data?.ok ? query.data.data : null;
  const loading = query.isLoading;
  const error = query.data && !query.data.ok ? query.data.error.message : query.error instanceof Error ? query.error.message : '';

  return <section className={`team-monitoring-member-detail${embedded ? ' is-embedded' : ''}`} aria-label="成员监控详情">
    <header>
      <div><span>成员</span><h2>{detail?.member.displayName ?? '成员详情'}</h2><small>{detail?.member.teamName ?? '正在读取范围'}</small></div>
      {onClose && <button type="button" onClick={onClose} aria-label="关闭成员详情" title="关闭"><X aria-hidden="true" /></button>}
    </header>
    {!online && <div className="team-monitoring-inline-state">联网后读取成员详情</div>}
    {loading && <div className="team-monitoring-inline-state"><Spin size="small" /> 正在读取</div>}
    {error && <div className="team-monitoring-inline-state is-error"><AlertCircle aria-hidden="true" />{error}</div>}
    {detail && <>
      <div className="team-monitoring-member-stats">
        <span><strong>{detail.member.counts.contacts}</strong><small>联系人</small></span>
        <span><strong>{detail.member.counts.replied}</strong><small>已收到</small></span>
        <span><strong>{detail.member.counts.openActions}</strong><small>待办</small></span>
        <span><strong>{detail.member.counts.openAttention}</strong><small>关注</small></span>
      </div>
      <div className="team-monitoring-member-rates"><span>触达 {percent(detail.member.rates.contactRate)}</span><span>回复 {percent(detail.member.rates.replyRate)}</span><span>最近活动 {dateTime(detail.member.lastActivityAt)}</span></div>
      <section className="team-monitoring-detail-section">
        <div className="team-monitoring-detail-heading"><Target aria-hidden="true" /><h3>近期动作</h3><span>{detail.recentActions.length}</span></div>
        {detail.recentActions.length === 0 ? <div className="team-monitoring-inline-state">暂无待办或关注项</div> : detail.recentActions.map(action => <div key={action.actionId} className="team-monitoring-detail-row">
          <span className={`team-monitoring-priority is-${action.priority}`}>{priorityLabel(action.priority)}</span>
          <span><strong>{action.title}</strong><small>{action.customerName}{action.contactName ? ` · ${action.contactName}` : ''}</small></span>
          <small>{dateTime(action.dueAt ?? action.occurredAt)}</small>
        </div>)}
      </section>
      <section className="team-monitoring-detail-section">
        <div className="team-monitoring-detail-heading"><UserRound aria-hidden="true" /><h3>关注项</h3><span>{detail.attention.length}</span></div>
        {detail.attention.length === 0 ? <div className="team-monitoring-inline-state">暂无关注项</div> : detail.attention.map(item => <div key={item.itemId} className="team-monitoring-detail-row">
          <span className={`team-monitoring-priority is-${item.priority}`}>{priorityLabel(item.priority)}</span>
          <span><strong>{item.reason}</strong><small>{item.customerName} · {item.contactName}</small></span>
          <small>{dateTime(item.updatedAt)}</small>
        </div>)}
      </section>
      <section className="team-monitoring-detail-section">
        <div className="team-monitoring-detail-heading"><Mail aria-hidden="true" /><h3>近期邮件</h3><span>{detail.recentMail.length}</span></div>
        {detail.recentMail.length === 0 ? <div className="team-monitoring-inline-state">暂无邮件记录</div> : detail.recentMail.map(mail => <button key={mail.eventId} type="button" className="team-monitoring-mail-row" onClick={() => onOpenMail(mail)}>
          <span className={`team-monitoring-mail-kind is-${mail.classification ?? 'other'}`}><Clock3 aria-hidden="true" /></span>
          <span><strong>{mail.subject || '无主题'}</strong><small>{mail.summary || mail.nextAction || '仅结构化摘要'}</small></span>
          <ExternalLink aria-hidden="true" />
        </button>)}
      </section>
    </>}
  </section>;
}
