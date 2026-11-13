import { useEffect, useState } from 'react';
import { Plus, RefreshCw, Search, X } from 'lucide-react';
import { Drawer } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import type { TeamAdminSummary, TeamContext, TeamSnapshot } from '../../../shared/online-crm';
import { teamAccessFor } from '../../../shared/team-workspace';
import { useIdentity } from '../../IdentityContext';
import { useVisiblePolling } from '../../hooks/useVisiblePolling';
import { PersonalWorkspace } from './PersonalWorkspace';
import { TeamAdminView } from './TeamAdminView';
import { TeamInfoView } from './TeamInfoView';
import { TeamMonitoringView, TeamPerformanceView } from './TeamMonitoringView';
import { TeamSetupView } from './TeamSetupView';
import { TeamAttentionPanel } from './TeamAttentionPanel';
import { useTeamContext, useTeamDetail } from './team-data';
import './team-workspace.css';

type Section = 'workspace' | 'team' | 'performance' | 'monitoring' | 'overview' | 'setup';
const TEAM_CONTEXT_POLL_MS = 2_000;
const TRANSIENT_TEAM_CONTEXT_ERRORS = new Set(['DATABASE_ERROR', 'TIMEOUT', 'UNAVAILABLE']);

function summaryForTeam(team: TeamSnapshot, pendingInvitationCount: number): TeamAdminSummary {
  return {
    teamId: team.teamId,
    name: team.name,
    unitType: team.unitType,
    organizationKind: team.unitType === 'operations' ? 'operations_group' : 'sales_team',
    parentTeamId: team.parentTeamId,
    parentTeamName: team.parentTeamName,
    depth: 0,
    childCount: 0,
    leaderName: team.leaderName,
    memberCount: team.memberCount ?? team.members.length,
    pendingInvitationCount,
    createdAt: team.createdAt,
    version: team.version,
  };
}

function readAttentionFocusId(): string | null {
  const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
  return params.get('attention');
}

export function TeamWorkspace() {
  const { identity, status } = useIdentity();
  const queryClient = useQueryClient();
  const access = teamAccessFor(identity);
  const contextQuery = useTeamContext(access !== 'none');
  const [retainedContext, setRetainedContext] = useState<TeamContext | null>(null);
  const [attentionFocusId, setAttentionFocusId] = useState<string | null>(readAttentionFocusId);
  const [section, setSection] = useState<Section>(() => readAttentionFocusId() ? 'workspace' : access === 'manager' ? 'overview' : 'workspace');
  const [search, setSearch] = useState('');
  const [adminTeamId, setAdminTeamId] = useState<string | null>(null);
  const [selectedManagedTeamId, setSelectedManagedTeamId] = useState<string | null>(null);
  const signedIn = !!identity && ['authenticated', 'offline'].includes(status);
  const online = status === 'authenticated';
  const transientContextError = contextQuery.data && !contextQuery.data.ok
    ? TRANSIENT_TEAM_CONTEXT_ERRORS.has(contextQuery.data.error.code)
    : false;
  const context = contextQuery.data?.ok
    ? contextQuery.data.data
    : transientContextError ? retainedContext : null;
  const team = context?.team ?? null;
  const canAdmin = context?.canAdmin ?? false;
  const managedTeams = context?.managedTeams ?? [];
  const hasManagedTeam = managedTeams.length > 0;
  const isTeamLeader = !!team?.leaderUserId && team.leaderUserId === identity?.userId;
  const canManageTeam = canAdmin || hasManagedTeam || isTeamLeader;
  const ownTeam = team ? summaryForTeam(team, (context?.outgoingInvitations ?? []).filter(item => item.status === 'pending').length) : null;
  const managementTeams = canAdmin ? context?.adminTeams ?? [] : hasManagedTeam ? managedTeams : ownTeam ? [ownTeam] : [];
  const canManageStructure = canAdmin || hasManagedTeam || !!team;
  const canMonitor = !!identity && (identity.identityAdmin || identity.crmRoles.some(role => role === 'admin' || role === 'operations') || hasManagedTeam || isTeamLeader);
  const canViewPerformance = access === 'manager';
  const selectedTeamId = selectedManagedTeamId && managedTeams.some(item => item.teamId === selectedManagedTeamId)
    ? selectedManagedTeamId
    : managedTeams[0]?.teamId ?? team?.teamId ?? null;
  const managedDetail = useTeamDetail(selectedTeamId && selectedTeamId !== team?.teamId ? selectedTeamId : null, section === 'team' && !canAdmin);
  const displayedTeam = managedDetail.data?.ok && managedDetail.data.data.team.teamId === selectedTeamId ? managedDetail.data.data.team : team;
  useEffect(() => {
    if (contextQuery.data?.ok) setRetainedContext(contextQuery.data.data);
  }, [contextQuery.data]);
  useEffect(() => {
    if (!context) return;
    if (attentionFocusId) return;
    if ((team || hasManagedTeam) && section === 'setup' && !canAdmin) setSection('workspace');
    if (!team && !hasManagedTeam && !canManageStructure && section !== 'setup') setSection('setup');
  }, [attentionFocusId, context, team?.teamId, hasManagedTeam, canManageStructure, section]);
  useEffect(() => {
    const focusAttention = () => {
      const itemId = readAttentionFocusId();
      setAttentionFocusId(itemId);
    };
    window.addEventListener('hashchange', focusAttention);
    return () => window.removeEventListener('hashchange', focusAttention);
  }, []);
  useEffect(() => {
    if (!online) return;
    const refresh = () => { void contextQuery.refetch(); };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [online, contextQuery.refetch]);
  useVisiblePolling(async () => { await contextQuery.refetch(); }, TEAM_CONTEXT_POLL_MS, online);

  const refreshVisibleData = async () => {
    await queryClient.invalidateQueries();
    await contextQuery.refetch();
  };

  const renderBody = () => {
    if (!signedIn) return <section className="team-page-state"><strong>请先登录中心账号</strong></section>;
    if (access === 'none') return <section className="team-page-state"><strong>当前账号没有团队工作区权限</strong></section>;
    if (!online && !context) return <section className="team-page-state"><strong>联网后读取团队信息</strong></section>;
    if (contextQuery.isLoading && !context) return <section className="team-page-state">正在读取团队信息</section>;
    if (contextQuery.data && !contextQuery.data.ok && !context) return <section className="team-page-state is-error">{contextQuery.data.error.message}</section>;
    if (!context) return <section className="team-page-state">团队信息不可用</section>;
    if (section === 'performance' && canViewPerformance) return <TeamPerformanceView teams={managementTeams} online={online} search={search} />;
    if (section === 'monitoring' && canMonitor) return <TeamMonitoringView identity={identity} teams={managementTeams} online={online} search={search} />;
    if (section === 'overview' && canManageStructure) return <TeamAdminView canManage={canManageTeam} teams={managementTeams} organization={context.organization} selectedTeamId={adminTeamId} search={search} onSearch={setSearch} onSelect={setAdminTeamId} onChanged={() => { void contextQuery.refetch(); }} />;
    if (section === 'workspace') return <PersonalWorkspace includeTasks={online} search={search} teamName={(displayedTeam ?? team)?.name} leaderName={(displayedTeam ?? team)?.leaderName} memberCount={(displayedTeam ?? team)?.memberCount ?? (displayedTeam ?? team)?.members.length} />;
    if (!team && !hasManagedTeam) return <TeamSetupView context={context} online={online} onBack={canAdmin ? () => setSection('overview') : undefined} onContext={() => { void contextQuery.refetch(); }} onCreated={receipt => { if (canAdmin) { setAdminTeamId(receipt.teamId); setSection('overview'); } else { setSection('workspace'); } void contextQuery.refetch(); }} />;
    if (section === 'setup') return <TeamSetupView context={context} online={online} onBack={canAdmin ? () => setSection('overview') : undefined} onContext={() => { void contextQuery.refetch(); }} onCreated={receipt => { if (canAdmin) { setAdminTeamId(receipt.teamId); setSection('overview'); } else { setSection('workspace'); } void contextQuery.refetch(); }} />;
    if (section === 'team' && displayedTeam) return <TeamInfoView team={displayedTeam} outgoingInvitations={managedDetail.data?.ok ? managedDetail.data.data.outgoingInvitations : context.outgoingInvitations} managedTeams={managementTeams.length ? managementTeams : [{ teamId: displayedTeam.teamId, name: displayedTeam.name, parentTeamId: displayedTeam.parentTeamId, parentTeamName: displayedTeam.parentTeamName, depth: 0, childCount: 0, leaderName: displayedTeam.leaderName, memberCount: displayedTeam.members.length, pendingInvitationCount: context.outgoingInvitations.length, createdAt: displayedTeam.createdAt, unitType: displayedTeam.unitType }]} selectedTeamId={displayedTeam.teamId} onSelectTeam={setSelectedManagedTeamId} canInvite={displayedTeam.leaderUserId === identity?.userId} canLeave={displayedTeam.members.some(member => member.userId === identity?.userId && member.role === 'member')} online={online} onChanged={() => { void contextQuery.refetch(); void managedDetail.refetch(); }} onDissolved={() => { setSelectedManagedTeamId(null); setAdminTeamId(null); setSection(canAdmin ? 'overview' : 'workspace'); void contextQuery.refetch(); }} />;
    return <PersonalWorkspace includeTasks={online} search={search} teamName={(displayedTeam ?? team)?.name} leaderName={(displayedTeam ?? team)?.leaderName} memberCount={(displayedTeam ?? team)?.memberCount ?? (displayedTeam ?? team)?.members.length} />;
  };

  return <div className={`team-workspace-page team-access-${access}`}>
    {access !== 'none' && signedIn && context && <div className="team-workspace-context-bar">
      <nav className="team-section-tabs" aria-label="团队视图">
        {(team || hasManagedTeam || canManageStructure) && <button type="button" aria-current={section === 'workspace' ? 'page' : undefined} onClick={() => setSection('workspace')}>个人</button>}
        {canManageStructure && <button type="button" aria-current={section === 'overview' ? 'page' : undefined} onClick={() => { setAdminTeamId(null); setSection('overview'); }}>我的团队</button>}
        {canMonitor && <button type="button" aria-current={section === 'monitoring' ? 'page' : undefined} onClick={() => setSection('monitoring')}>监控</button>}
        {(team || hasManagedTeam) && <button type="button" aria-current={section === 'team' ? 'page' : undefined} onClick={() => setSection('team')}>团队管理</button>}
        {canViewPerformance && <button type="button" aria-current={section === 'performance' ? 'page' : undefined} onClick={() => setSection('performance')}>绩效</button>}
        {!team && !hasManagedTeam && !canAdmin && <button type="button" aria-current={section === 'setup' ? 'page' : undefined} onClick={() => setSection('setup')}>创建 / 加入</button>}
      </nav>
      <div className="team-workspace-context-tools">
        <label className="team-workspace-search">
          <Search aria-hidden="true" />
          <input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索团队、负责人或成员" aria-label="搜索团队、负责人或成员" />
          {search && <button type="button" onClick={() => setSearch('')} aria-label="清除搜索" title="清除搜索"><X aria-hidden="true" /></button>}
        </label>
        <button type="button" className="team-workspace-refresh" onClick={() => void refreshVisibleData()} aria-label="刷新团队数据" title="刷新"><RefreshCw aria-hidden="true" /></button>
        {section === 'overview' && canManageStructure && context.canCreate && <button type="button" className="team-action-primary team-workspace-primary-action" onClick={() => setSection('setup')}><Plus aria-hidden="true" />新建团队</button>}
      </div>
    </div>}
    {renderBody()}
    <Drawer open={Boolean(attentionFocusId)} placement="right" width={560} title={null} rootClassName="team-attention-drawer"
      getContainer={false} styles={{ body: { padding: 0, height: '100%' } }} onClose={() => {
        setAttentionFocusId(null);
        window.history.replaceState(null, '', '#/team');
      }}>
      {attentionFocusId && <TeamAttentionPanel online={online} focusItemId={attentionFocusId} />}
    </Drawer>
  </div>;
}
