import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, AlertCircle, ArrowUpRight, Building2, CalendarDays, Clock3, Mail, RefreshCw, ShieldCheck, Timer, TrendingUp, UsersRound } from 'lucide-react';
import { Button, Drawer, Empty, Pagination, Spin, Tag } from 'antd';
import type { Identity } from '../../../../server/core/auth';
import {
  ONLINE_CHANNELS,
  SALES_PERFORMANCE_LIMITS,
  type DurationMetric,
  type Result,
  type SalesPerformanceOverview,
  type SalesPerformanceQuery,
  type SalesPerformanceRow,
  type SalesPerformanceStratum,
  type TeamAdminSummary,
  type TeamMonitoringContactSummary,
  type TeamMonitoringMailDetail,
  type TeamMonitoringMailSummary,
  type TeamMonitoringOverview,
} from '../../../shared/online-crm';
import { TeamMonitoringMemberDetail } from './TeamMonitoringMemberDetail';

const MONITORING_PAGE_SIZE = 10;
const MONITORING_UNIT_PAGE_SIZE = 20;
const CONTACT_MAIL_PAGE_SIZE = 20;
const PERFORMANCE_PAGE_SIZE = SALES_PERFORMANCE_LIMITS.page;
const PERFORMANCE_WINDOW_DAYS = SALES_PERFORMANCE_LIMITS.defaultWindowDays;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3_600;
const SECONDS_PER_DAY = 86_400;
const MILLISECONDS_PER_DAY = 86_400_000;

function invoke<T>(channel: string, ...args: unknown[]): Promise<Result<T>> {
  return window.api.invoke(channel, ...args) as Promise<Result<T>>;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function dateTime(value: string | null): string {
  if (!value) return '暂无';
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function scopeLabel(scope: TeamMonitoringOverview['scope']): string {
  if (scope === 'leader') return '负责团队';
  if (scope === 'operations') return '运营共享';
  return '全局';
}

function stageLabel(value: string): string {
  return ({ cold: '未联系', reaching: '触达中', quoting: '报价中', trial: '试单中', cooperating: '合作中', lost: '已流失', other: '其他' } as Record<string, string>)[value] ?? value;
}

function touchLabel(value: string): string {
  return ({ uncontacted: '未触达', contacted: '已触达', replied: '已收到', bounced: '退信', autoreply: '自动回复' } as Record<string, string>)[value] ?? value;
}

function teamOptions(teams: readonly TeamAdminSummary[]): TeamAdminSummary[] {
  const seen = new Set<string>();
  return teams.filter(team => {
    if (seen.has(team.teamId)) return false;
    seen.add(team.teamId);
    return true;
  });
}

function inputDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function dateBoundary(value: string, end = false): string {
  return new Date(`${value}T${end ? '23:59:59.999' : '00:00:00.000'}Z`).toISOString();
}

function performanceScopeLabel(scope: SalesPerformanceOverview['scope'] | undefined): string {
  if (scope === 'self') return '我的绩效';
  if (scope === 'leader') return '团队绩效';
  if (scope === 'operations') return '运营范围绩效';
  if (scope === 'superadmin') return '全局绩效';
  return '销售绩效';
}

function durationLabel(seconds: number | null): string {
  if (seconds === null) return '暂无';
  if (seconds < SECONDS_PER_HOUR) return `${Math.max(1, Math.round(seconds / SECONDS_PER_MINUTE))} 分钟`;
  if (seconds < SECONDS_PER_DAY) return `${(seconds / SECONDS_PER_HOUR).toFixed(1)} 小时`;
  return `${(seconds / SECONDS_PER_DAY).toFixed(1)} 天`;
}

function durationSamples(metric: DurationMetric): string {
  return metric.sufficient ? `${metric.sampleCount} 个样本` : `${metric.sampleCount}/${metric.minimumSampleSize} 样本`;
}

function performanceGroupLabel(value: SalesPerformanceStratum): string {
  return ({ lead: '联系人', source: '来源', batch: '导入批次', country: '国家' } as const)[value];
}

function DurationMetricCell({ label, metric }: { label: string; metric: DurationMetric }) {
  return <div className={`team-performance-metric${metric.sufficient ? '' : ' is-insufficient'}`}>
    <span>{label}</span>
    <strong>{metric.sufficient ? durationLabel(metric.medianSeconds) : '样本不足'}</strong>
    <small>中位数</small>
    <small>{metric.sufficient ? `P90 ${durationLabel(metric.p90Seconds)}` : durationSamples(metric)}</small>
  </div>;
}

function performanceRow(row: SalesPerformanceRow): JSX.Element {
  const repeat = row.metrics.repeatPurchase;
  return <article key={row.key} className="team-performance-row">
    <header>
      <span><strong>{row.label}</strong><small>{[row.memberName, row.teamName].filter(Boolean).join(' · ') || '当前范围'}</small></span>
      <span><strong>{row.claimCount}</strong><small>领取</small></span>
      <span><strong>{row.validReplyCount}</strong><small>有效回复</small></span>
      <span><strong>{row.wonOpportunityCount}</strong><small>成交</small></span>
    </header>
    <div className="team-performance-metrics">
      <DurationMetricCell label="首次动作" metric={row.metrics.claimToFirstAction} />
      <DurationMetricCell label="有效回复" metric={row.metrics.claimToValidReply} />
      <DurationMetricCell label="成交耗时" metric={row.metrics.claimToWon} />
      <div className={`team-performance-metric${repeat.rate.sufficient ? '' : ' is-insufficient'}`}>
        <span>复购</span>
        <strong>{repeat.rate.sufficient ? percent(repeat.rate.rate ?? 0) : '样本不足'}</strong>
        <small>复购率</small>
        <small>{repeat.rate.sufficient ? `${repeat.repeatPurchaseCustomers}/${repeat.wonCustomers} 位客户` : `${repeat.rate.sampleCount}/${repeat.rate.minimumSampleSize} 样本`}</small>
      </div>
    </div>
  </article>;
}

interface PerformanceDraft {
  teamId: string;
  groupBy: SalesPerformanceStratum;
  from: string;
  to: string;
  source: string;
  batchId: string;
  country: string;
}

export function TeamPerformanceView({ teams = [], online }: {
  teams?: readonly TeamAdminSummary[];
  online: boolean;
}) {
  const selection = useMemo(() => teamOptions(teams), [teams]);
  const today = useMemo(() => new Date(), []);
  const initial = useMemo<PerformanceDraft>(() => ({
    teamId: '',
    groupBy: 'lead',
    from: inputDate(new Date(today.getTime() - PERFORMANCE_WINDOW_DAYS * MILLISECONDS_PER_DAY)),
    to: inputDate(today),
    source: '',
    batchId: '',
    country: '',
  }), [today]);
  const [draft, setDraft] = useState(initial);
  const [applied, setApplied] = useState(initial);
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<SalesPerformanceOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestVersion = useRef(0);

  useEffect(() => {
    const version = ++requestVersion.current;
    setError('');
    if (!online) {
      setLoading(false);
      return;
    }
    const query: SalesPerformanceQuery = {
      from: dateBoundary(applied.from),
      to: dateBoundary(applied.to, true),
      groupBy: applied.groupBy,
      limit: PERFORMANCE_PAGE_SIZE,
      offset: (page - 1) * PERFORMANCE_PAGE_SIZE,
      ...(applied.teamId ? { teamId: applied.teamId } : {}),
      ...(applied.source.trim() ? { source: applied.source.trim() } : {}),
      ...(applied.batchId.trim() ? { batchId: applied.batchId.trim() } : {}),
      ...(applied.country.trim() ? { country: applied.country.trim() } : {}),
    };
    setLoading(true);
    void invoke<SalesPerformanceOverview>(ONLINE_CHANNELS.SALES_PERFORMANCE, query).then(result => {
      if (requestVersion.current !== version) return;
      setLoading(false);
      if (result.ok) setData(result.data);
      else setError(result.error.message);
    });
  }, [applied, online, page, revision]);

  const apply = () => {
    if (!draft.from || !draft.to || draft.from > draft.to) {
      setError('结束日期需要晚于开始日期');
      return;
    }
    if (draft.batchId.trim() && !/^[a-f0-9-]{36}$/i.test(draft.batchId.trim())) {
      setError('批次编号格式不正确');
      return;
    }
    setError('');
    setPage(1);
    setApplied({ ...draft });
  };

  return <div className="team-performance-view">
    <div className="team-performance-toolbar">
      <div className="team-performance-heading"><TrendingUp aria-hidden="true" /><span><strong>{performanceScopeLabel(data?.scope)}</strong><small>{data ? `${data.total} 个分组` : '实时业务指标'}</small></span></div>
      <button type="button" onClick={() => setRevision(value => value + 1)} disabled={!online || loading} aria-label="刷新绩效数据" title="刷新"><RefreshCw className={loading ? 'is-spinning' : undefined} aria-hidden="true" /></button>
    </div>
    <form className="team-performance-form" onSubmit={event => { event.preventDefault(); apply(); }}>
      {selection.length > 0 && <label><Building2 aria-hidden="true" /><span>团队</span><select aria-label="选择绩效团队" value={draft.teamId} onChange={event => setDraft({ ...draft, teamId: event.target.value })}><option value="">全部范围</option>{selection.map(team => <option key={team.teamId} value={team.teamId}>{team.name}</option>)}</select></label>}
      <label><Activity aria-hidden="true" /><span>分组</span><select aria-label="绩效分组" value={draft.groupBy} onChange={event => setDraft({ ...draft, groupBy: event.target.value as SalesPerformanceStratum })}>{(['lead', 'source', 'batch', 'country'] as const).map(value => <option key={value} value={value}>{performanceGroupLabel(value)}</option>)}</select></label>
      <label><CalendarDays aria-hidden="true" /><span>开始</span><input type="date" aria-label="绩效开始日期" value={draft.from} onChange={event => setDraft({ ...draft, from: event.target.value })} /></label>
      <label><CalendarDays aria-hidden="true" /><span>结束</span><input type="date" aria-label="绩效结束日期" value={draft.to} onChange={event => setDraft({ ...draft, to: event.target.value })} /></label>
      <label><span>来源</span><input aria-label="来源筛选" value={draft.source} maxLength={SALES_PERFORMANCE_LIMITS.text} placeholder="全部来源" onChange={event => setDraft({ ...draft, source: event.target.value })} /></label>
      <label><span>批次</span><input aria-label="批次筛选" value={draft.batchId} maxLength={36} placeholder="批次编号" onChange={event => setDraft({ ...draft, batchId: event.target.value })} /></label>
      <label><span>国家</span><input aria-label="国家筛选" value={draft.country} maxLength={SALES_PERFORMANCE_LIMITS.text} placeholder="全部国家" onChange={event => setDraft({ ...draft, country: event.target.value })} /></label>
      <Button htmlType="submit" size="small">应用</Button>
    </form>
    {!online && <div className="team-performance-state">联网后读取销售绩效</div>}
    {loading && !data && <div className="team-performance-state"><Spin size="small" /> 正在读取绩效</div>}
    {error && <div className="team-performance-state is-error"><AlertCircle aria-hidden="true" />{error}</div>}
    {data && data.items.length === 0 && !loading && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前范围暂无绩效数据" />}
    {data && data.items.length > 0 && <>
      <div className="team-performance-list" aria-label="销售绩效">{data.items.map(performanceRow)}</div>
      {data.total > PERFORMANCE_PAGE_SIZE && <div className="team-performance-pagination"><Pagination size="small" current={page} pageSize={PERFORMANCE_PAGE_SIZE} total={data.total} showSizeChanger={false} onChange={setPage} /></div>}
    </>}
    {data && <div className="team-performance-footnote"><Timer aria-hidden="true" />样本不足不展示排名或分配建议</div>}
  </div>;
}

export function TeamMonitoringView({ identity, teams, online }: {
  identity: Identity;
  teams: readonly TeamAdminSummary[];
  online: boolean;
}) {
  const selection = useMemo(() => teamOptions(teams), [teams]);
  const [teamId, setTeamId] = useState('');
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [overview, setOverview] = useState<TeamMonitoringOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [contactReference, setContactReference] = useState<{ contactId: number; customerId: string } | null>(null);
  const [contact, setContact] = useState<TeamMonitoringContactSummary | null>(null);
  const [contactLoading, setContactLoading] = useState(false);
  const [contactError, setContactError] = useState('');
  const [mailDetail, setMailDetail] = useState<TeamMonitoringMailDetail | null>(null);
  const [mailLoading, setMailLoading] = useState(false);
  const [mailError, setMailError] = useState('');
  const requestVersion = useRef(0);

  useEffect(() => {
    const version = ++requestVersion.current;
    setError('');
    if (!online) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void invoke<TeamMonitoringOverview>(ONLINE_CHANNELS.TEAM_MONITORING, {
      ...(teamId ? { teamId } : {}),
      limit: MONITORING_PAGE_SIZE,
      offset: (page - 1) * MONITORING_PAGE_SIZE,
      unitLimit: MONITORING_UNIT_PAGE_SIZE,
      unitOffset: 0,
    }).then(result => {
      if (requestVersion.current !== version) return;
      setLoading(false);
      if (result.ok) setOverview(result.data);
      else setError(result.error.message);
    });
  }, [online, page, revision, teamId, identity.userId]);

  const changeTeam = (value: string) => {
    setTeamId(value);
    setPage(1);
    setSelectedMemberId(null);
  };

  const openContact = async (contactId: number, customerId: string, mail?: TeamMonitoringMailSummary) => {
    setContactReference({ contactId, customerId });
    setContact(null);
    setMailDetail(null);
    setContactError('');
    setMailError('');
    setContactLoading(true);
    const [contactResult, mailResult] = await Promise.all([
      invoke<TeamMonitoringContactSummary>(ONLINE_CHANNELS.TEAM_MONITORING_CONTACT, contactId, customerId, CONTACT_MAIL_PAGE_SIZE, 0),
      mail ? invoke<TeamMonitoringMailDetail>(ONLINE_CHANNELS.TEAM_MONITORING_MAIL, mail.eventId, contactId, customerId) : Promise.resolve(null),
    ]);
    setContactLoading(false);
    if (contactResult.ok) setContact(contactResult.data);
    else setContactError(contactResult.error.message);
    if (mailResult) {
      if (mailResult.ok) setMailDetail(mailResult.data);
      else setMailError(mailResult.error.message);
    }
  };

  const loadMail = async (mail: TeamMonitoringMailSummary) => {
    setMailLoading(true);
    setMailError('');
    const result = await invoke<TeamMonitoringMailDetail>(ONLINE_CHANNELS.TEAM_MONITORING_MAIL, mail.eventId, mail.contactId, mail.customerId);
    setMailLoading(false);
    if (result.ok) setMailDetail(result.data);
    else setMailError(result.error.message);
  };

  const openCustomerMonitor = () => {
    if (!contact) return;
    setContactReference(null);
    window.location.hash = `#/customers?monitorContact=${contact.contactId}&centerCustomer=${encodeURIComponent(contact.customerId)}`;
  };

  const hintScope = overview?.scope ?? (identity.identityAdmin || identity.crmRoles.includes('admin') ? 'superadmin' : identity.crmRoles.includes('operations') ? 'operations' : 'leader');
  return <div className="team-monitoring-view">
    <div className="team-monitoring-toolbar">
      <div className="team-monitoring-heading"><Activity aria-hidden="true" /><span><strong>{scopeLabel(hintScope)}</strong><small>{overview ? `${overview.members.total} 位成员` : '团队经营概览'}</small></span></div>
      <div className="team-monitoring-controls">
        <label><Building2 aria-hidden="true" /><span>团队</span><select value={teamId} onChange={event => changeTeam(event.target.value)} aria-label="选择监控团队"><option value="">全部范围</option>{selection.map(team => <option key={team.teamId} value={team.teamId}>{team.name} · {team.memberCount} 人</option>)}</select></label>
        <button type="button" onClick={() => setRevision(value => value + 1)} disabled={!online || loading} aria-label="刷新监控数据" title="刷新"><RefreshCw className={loading ? 'is-spinning' : undefined} aria-hidden="true" /></button>
      </div>
    </div>
    {!online && <div className="team-monitoring-state">联网后读取团队监控</div>}
    {loading && !overview && <div className="team-monitoring-state"><Spin size="small" /> 正在读取监控数据</div>}
    {error && <div className="team-monitoring-state is-error"><AlertCircle aria-hidden="true" />{error}</div>}
    {overview && <>
      <section className="team-monitoring-metrics" aria-label="团队监控汇总">
        <div><span>联系人</span><strong>{overview.counts.contacts}</strong><small>{overview.counts.contacted + overview.counts.replied} 已触达</small></div>
        <div><span>回复</span><strong>{overview.counts.replied}</strong><small>回复率 {percent(overview.rates.replyRate)}</small></div>
        <div><span>动作</span><strong>{overview.counts.openActions}</strong><small>{overview.counts.overdueActions} 已逾期</small></div>
        <div><span>关注</span><strong>{overview.counts.openAttention}</strong><small>{overview.counts.pendingTransfers} 待转交</small></div>
      </section>
      {overview.pool && <section className="team-monitoring-pool" aria-label="运营池">
        <span><ShieldCheck aria-hidden="true" />运营池</span>
        <strong>{overview.pool.unassignedOperationsContacts}</strong><small>未分配</small>
        <strong>{overview.pool.assignedOperationsContacts}</strong><small>已分配</small>
        <strong>{overview.pool.pendingAssignmentRequests + overview.pool.pendingTransferRequests}</strong><small>待处理</small>
      </section>}
      <div className="team-monitoring-body">
        <section className="team-monitoring-members" aria-label="成员监控">
          <div className="team-monitoring-section-heading"><div><UsersRound aria-hidden="true" /><h2>成员</h2><span>{overview.members.total}</span></div><small>第 {page} 页</small></div>
          {overview.members.items.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前范围暂无成员" /> : <div className="team-monitoring-member-list">
            {overview.members.items.map(member => <button type="button" key={member.userId} className={`team-monitoring-member-row${selectedMemberId === member.userId ? ' is-selected' : ''}`} onClick={() => setSelectedMemberId(member.userId)}>
              <span className="team-monitoring-avatar"><UsersRound aria-hidden="true" /></span>
              <span><strong>{member.displayName}</strong><small>{member.teamName}</small></span>
              <span><strong>{member.counts.openActions}</strong><small>动作</small></span>
              <span><strong>{member.counts.replied}</strong><small>回复</small></span>
              <span><strong>{member.counts.openAttention}</strong><small>关注</small></span>
              <ArrowUpRight aria-hidden="true" />
            </button>)}
          </div>}
          {overview.members.total > MONITORING_PAGE_SIZE && <Pagination size="small" current={page} pageSize={MONITORING_PAGE_SIZE} total={overview.members.total} showSizeChanger={false} onChange={setPage} />}
        </section>
        <aside className="team-monitoring-inspector">
          {selectedMemberId
            ? <TeamMonitoringMemberDetail userId={selectedMemberId} online={online} onClose={() => setSelectedMemberId(null)} onOpenMail={mail => void openContact(mail.contactId, mail.customerId, mail)} />
            : <section className="team-monitoring-replies" aria-label="重点回复">
              <div className="team-monitoring-section-heading"><div><Mail aria-hidden="true" /><h2>重点回复</h2><span>{overview.importantReplies.length}</span></div></div>
              {overview.importantReplies.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无重点回复" /> : overview.importantReplies.map(mail => <button key={mail.eventId} type="button" className="team-monitoring-reply-row" onClick={() => void openContact(mail.contactId, mail.customerId, mail)}>
                <span className="team-monitoring-mail-icon"><Mail aria-hidden="true" /></span>
                <span><strong>{mail.subject || '无主题'}</strong><small>{mail.summary || mail.nextAction || '客户回复'}</small></span>
                <small>{dateTime(mail.occurredAt)}</small>
              </button>)}
            </section>}
        </aside>
      </div>
      <section className="team-monitoring-units" aria-label="组织汇总">
        <div className="team-monitoring-section-heading"><div><Building2 aria-hidden="true" /><h2>范围</h2><span>{overview.units.total}</span></div></div>
        <div>{overview.units.items.map(unit => <button type="button" key={unit.unitId} className="team-monitoring-unit" onClick={() => changeTeam(unit.unitId)}>
          <span><strong>{unit.name}</strong><small>{unit.memberCount} 人 · {unit.kind === 'operations_group' ? '运营组' : '销售团队'}</small></span>
          <span><strong>{unit.counts.replied}</strong><small>回复</small></span>
          <span><strong>{unit.counts.openActions}</strong><small>动作</small></span>
        </button>)}</div>
      </section>
    </>}
    <Drawer className="team-monitoring-drawer" width={520} open={!!contactReference} onClose={() => setContactReference(null)} destroyOnHidden title={contact?.name ?? '联系人监督'}>
      {contactLoading && <div className="team-monitoring-state"><Spin size="small" /> 正在读取联系人</div>}
      {contactError && <div className="team-monitoring-state is-error"><AlertCircle aria-hidden="true" />{contactError}</div>}
      {contact && <div className="team-monitoring-contact-detail">
        <div className="team-monitoring-contact-head"><span><strong>{contact.companyName}</strong><small>{[contact.country, contact.title].filter(Boolean).join(' · ') || '公司资料'}</small></span><Button size="small" onClick={openCustomerMonitor}>客户页监督详情</Button></div>
        <div className="team-monitoring-contact-meta"><Tag>{touchLabel(contact.touchStatus)}</Tag><Tag>{stageLabel(contact.stage)}</Tag><span>{contact.ownerName || '未分配'}</span><small>读取编号 {contact.auditId.slice(0, 8)}</small></div>
        <section className="team-monitoring-detail-section"><div className="team-monitoring-detail-heading"><Mail aria-hidden="true" /><h3>邮件</h3><span>{contact.mail.total}</span></div>{contact.mail.items.map(mail => <button key={mail.eventId} type="button" className="team-monitoring-mail-row" onClick={() => void loadMail(mail)}><span className={`team-monitoring-mail-kind is-${mail.classification ?? 'other'}`}><Clock3 aria-hidden="true" /></span><span><strong>{mail.subject || '无主题'}</strong><small>{mail.summary || mail.nextAction || '仅结构化摘要'}</small></span><ArrowUpRight aria-hidden="true" /></button>)}</section>
        {mailLoading && <div className="team-monitoring-state"><Spin size="small" /> 正在读取邮件摘要</div>}
        {mailError && <div className="team-monitoring-state is-error"><AlertCircle aria-hidden="true" />{mailError}</div>}
        {mailDetail && <section className="team-monitoring-mail-detail"><span>{mailDetail.mail.classification || '未分类'} · {dateTime(mailDetail.mail.occurredAt)}</span><strong>{mailDetail.mail.subject || '无主题'}</strong><p>{mailDetail.mail.summary || '暂无摘要'}</p>{mailDetail.mail.nextAction && <small>下一步：{mailDetail.mail.nextAction}</small>}<em>读取编号 {mailDetail.auditId.slice(0, 8)}</em></section>}
      </div>}
    </Drawer>
  </div>;
}
