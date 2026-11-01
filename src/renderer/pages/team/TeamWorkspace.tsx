import { useEffect, useState } from 'react';
import { Activity, LayoutDashboard, Plus, ShieldCheck, TrendingUp, UsersRound } from 'lucide-react';
import { identityRoleLabel } from '../../../shared/online-crm';
import { teamAccessFor } from '../../../shared/team-workspace';
import { useIdentity } from '../../IdentityContext';
import { useVisiblePolling } from '../../hooks/useVisiblePolling';
import { PersonalWorkspace } from './PersonalWorkspace';
import { TeamAdminView } from './TeamAdminView';
import { TeamInfoView } from './TeamInfoView';
import { TeamMonitoringView, TeamPerformanceView } from './TeamMonitoringView';
import { TeamSetupView } from './TeamSetupView';
import { useTeamContext, useTeamDetail } from './team-data';
import './team-workspace.css';

type Section = 'workspace' | 'team' | 'performance' | 'monitoring' | 'overview' | 'setup';
const TEAM_CONTEXT_POLL_MS = 2_000;

function readAttentionFocusId(): string | null {
  const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
  return params.get('attention');
}

export function TeamWorkspace() {
  const { identity, status } = useIdentity();
  const access = teamAccessFor(identity);
  const contextQuery = useTeamContext(access !== 'none');
  const [attentionFocusId, setAttentionFocusId] = useState<string | null>(readAttentionFocusId);
  const [section, setSection] = useState<Section>(() => readAttentionFocusId() ? 'workspace' : access === 'manager' ? 'overview' : 'workspace');
  const [createParentId, setCreateParentId] = useState<string | null>(null);
  const [adminTeamId, setAdminTeamId] = useState<string | null>(null);
  const [selectedManagedTeamId, setSelectedManagedTeamId] = useState<string | null>(null);
  const signedIn = !!identity && ['authenticated', 'offline'].includes(status);
  const online = status === 'authenticated';
  const context = contextQuery.data?.ok ? contextQuery.data.data : null;
  const team = context?.team ?? null;
  const canAdmin = context?.canAdmin ?? false;
  const managedTeams = context?.managedTeams ?? [];
  const managementTeams = canAdmin ? context?.adminTeams ?? [] : managedTeams;
  const canManageStructure = canAdmin || managedTeams.length > 0;
  const hasManagedTeam = managedTeams.length > 0;
  const isTeamLeader = !!team?.leaderUserId && team.leaderUserId === identity?.userId;
  const canMonitor = !!identity && (identity.identityAdmin || identity.crmRoles.some(role => role === 'admin' || role === 'operations') || hasManagedTeam || isTeamLeader);
  const canViewPerformance = access === 'manager';
  const selectedTeamId = selectedManagedTeamId && managedTeams.some(item => item.teamId === selectedManagedTeamId)
    ? selectedManagedTeamId
    : managedTeams[0]?.teamId ?? team?.teamId ?? null;
  const managedDetail = useTeamDetail(selectedTeamId && selectedTeamId !== team?.teamId ? selectedTeamId : null, section === 'team' && !canAdmin);
  const displayedTeam = managedDetail.data?.ok && managedDetail.data.data.team.teamId === selectedTeamId ? managedDetail.data.data.team : team;
  const createParent = createParentId ? context?.adminTeams.find(item => item.teamId === createParentId) : null;
  const page = section === 'team' && (displayedTeam || team)
    ? { crumb: `团队 / ${(displayedTeam ?? team)!.name}`, title: '我的团队', meta: `${(displayedTeam ?? team)!.memberCount ?? (displayedTeam ?? team)!.members.length} 位成员` }
    : section === 'monitoring' && canMonitor
      ? { crumb: '团队 / 监控', title: '团队监控', meta: identity ? identityRoleLabel(identity) : '等待账号信息' }
    : section === 'performance' && canViewPerformance
      ? { crumb: '团队 / 绩效', title: '团队绩效', meta: '最近 90 天' }
    : section === 'overview' && canManageStructure
      ? { crumb: '团队 / 团队管理', title: '团队管理', meta: `${managementTeams.length} 个团队` }
      : section === 'setup' || (!team && !hasManagedTeam)
        ? { crumb: context?.isSuperAdmin ? '团队 / 团队树 / 创建团队' : '团队 / 创建与加入', title: createParent ? `在 ${createParent.name} 下创建团队` : context?.isSuperAdmin ? '创建团队' : '创建或加入团队', meta: identity ? identityRoleLabel(identity) : '等待账号信息' }
        : { crumb: '团队 / 工作台', title: '个人工作台', meta: identity ? identityRoleLabel(identity) : '等待账号信息' };

  useEffect(() => {
    if (!context) return;
    if (attentionFocusId) return;
    if ((team || hasManagedTeam) && section === 'setup' && !canAdmin) setSection('workspace');
    if (!team && !hasManagedTeam && section !== 'setup' && section !== 'overview' && section !== 'monitoring' && section !== 'performance') setSection(canManageStructure ? 'overview' : 'setup');
  }, [attentionFocusId, context, team?.teamId, hasManagedTeam, canManageStructure, section]);
  useEffect(() => {
    const focusAttention = () => {
      const itemId = readAttentionFocusId();
      setAttentionFocusId(itemId);
      if (itemId) setSection('workspace');
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

  const renderBody = () => {
    if (!signedIn) return <section className="team-page-state"><strong>请先登录中心账号</strong></section>;
    if (access === 'none') return <section className="team-page-state"><strong>当前账号没有团队工作区权限</strong></section>;
    if (!online && !context) return <section className="team-page-state"><strong>联网后读取团队信息</strong></section>;
    if (contextQuery.isLoading && !context) return <section className="team-page-state">正在读取团队信息</section>;
    if (contextQuery.data && !contextQuery.data.ok) return <section className="team-page-state is-error">{contextQuery.data.error.message}</section>;
    if (!context) return <section className="team-page-state">团队信息不可用</section>;
    if (section === 'performance' && canViewPerformance) return <TeamPerformanceView teams={managementTeams} online={online} />;
    if (section === 'monitoring' && canMonitor) return <TeamMonitoringView identity={identity} teams={managementTeams} online={online} />;
    if (section === 'overview' && canManageStructure) return <TeamAdminView teams={managementTeams} organization={context.organization} selectedTeamId={adminTeamId} canCreate={context.canCreate} canCreateChild={canAdmin} onSelect={setAdminTeamId} onCreateTeam={parentTeamId => { setCreateParentId(parentTeamId); setSection('setup'); }} onChanged={() => { void contextQuery.refetch(); }} />;
    if (!team && !hasManagedTeam) return <TeamSetupView context={context} online={online} parentTeamId={canAdmin ? createParentId : null} onBack={canAdmin ? () => setSection('overview') : undefined} onContext={() => { void contextQuery.refetch(); }} onCreated={receipt => { if (canAdmin) { setAdminTeamId(receipt.teamId); setCreateParentId(null); setSection('overview'); } else { setSection('workspace'); } void contextQuery.refetch(); }} />;
    if (section === 'setup') return <TeamSetupView context={context} online={online} parentTeamId={canAdmin ? createParentId : null} onBack={canAdmin ? () => setSection('overview') : undefined} onContext={() => { void contextQuery.refetch(); }} onCreated={receipt => { if (canAdmin) { setAdminTeamId(receipt.teamId); setCreateParentId(null); setSection('overview'); } else { setSection('workspace'); } void contextQuery.refetch(); }} />;
    if (section === 'team' && displayedTeam) return <TeamInfoView team={displayedTeam} outgoingInvitations={managedDetail.data?.ok ? managedDetail.data.data.outgoingInvitations : context.outgoingInvitations} managedTeams={managedTeams.length ? managedTeams : [{ teamId: displayedTeam.teamId, name: displayedTeam.name, parentTeamId: displayedTeam.parentTeamId, parentTeamName: displayedTeam.parentTeamName, depth: 0, childCount: 0, leaderName: displayedTeam.leaderName, memberCount: displayedTeam.members.length, pendingInvitationCount: context.outgoingInvitations.length, createdAt: displayedTeam.createdAt, unitType: displayedTeam.unitType }]} selectedTeamId={displayedTeam.teamId} onSelectTeam={setSelectedManagedTeamId} canInvite={displayedTeam.leaderUserId === identity?.userId} online={online} onChanged={() => { void contextQuery.refetch(); void managedDetail.refetch(); }} onDissolved={() => { setSelectedManagedTeamId(null); setAdminTeamId(null); setSection(canAdmin ? 'overview' : 'workspace'); void contextQuery.refetch(); }} />;
    return <PersonalWorkspace includeTasks={access === 'member' && online} online={online} attentionFocusId={attentionFocusId} />;
  };

  return <div className={`team-workspace-page team-access-${access}`}>
    <header className="team-workspace-header"><div><div className="team-workspace-crumb">{page.crumb}</div><div className="team-workspace-title-line"><h1>{page.title}</h1><span>{page.meta}</span></div></div></header>
    {access !== 'none' && signedIn && context && <nav className="team-section-tabs" aria-label="团队视图">
      {(team || hasManagedTeam) && <button type="button" aria-current={section === 'workspace' ? 'page' : undefined} onClick={() => setSection('workspace')}><LayoutDashboard aria-hidden="true" />工作台</button>}
      {(team || hasManagedTeam) && <button type="button" aria-current={section === 'team' ? 'page' : undefined} onClick={() => setSection('team')}><UsersRound aria-hidden="true" />我的团队</button>}
      {canViewPerformance && <button type="button" aria-current={section === 'performance' ? 'page' : undefined} onClick={() => setSection('performance')}><TrendingUp aria-hidden="true" />绩效</button>}
      {!team && !hasManagedTeam && !canAdmin && <button type="button" aria-current={section === 'setup' ? 'page' : undefined} onClick={() => setSection('setup')}><Plus aria-hidden="true" />创建 / 加入</button>}
      {canMonitor && <button type="button" aria-current={section === 'monitoring' ? 'page' : undefined} onClick={() => setSection('monitoring')}><Activity aria-hidden="true" />监控</button>}
      {canManageStructure && <button type="button" aria-current={section === 'overview' ? 'page' : undefined} onClick={() => { setAdminTeamId(null); setSection('overview'); }}><ShieldCheck aria-hidden="true" />团队管理</button>}
    </nav>}
    {renderBody()}
  </div>;
}
