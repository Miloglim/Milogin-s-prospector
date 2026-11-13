import { useEffect, useState } from 'react';
import { Activity, BadgeDollarSign, Building2, Eye, GitBranch, ListTree, Mail, MailPlus, Network, Paperclip, Send, UsersRound } from 'lucide-react';
import type { OrganizationContext, TeamAdminSummary } from '../../../shared/online-crm';
import { useIdentity } from '../../IdentityContext';
import { TeamAdminInspector, TeamAdminOverview } from './TeamAdminInspector';
import { TeamOrgCanvas } from './TeamOrgCanvas';
import { effectiveTeamParentId } from './team-admin-layout';
import { useTeamDetail } from './team-data';

type TeamAdminMode = 'directory' | 'canvas';

function isOperations(team: TeamAdminSummary): boolean {
  return team.unitType === 'operations';
}

export function TeamAdminView({ canManage, teams, organization, selectedTeamId, search, onSearch, onSelect, onChanged }: {
  canManage: boolean;
  teams: readonly TeamAdminSummary[];
  organization?: OrganizationContext;
  selectedTeamId: string | null;
  search: string;
  onSearch: (value: string) => void;
  onSelect: (teamId: string | null) => void;
  onChanged: () => void;
}) {
  const { identity, status } = useIdentity();
  const online = status === 'authenticated';
  const [mode, setMode] = useState<TeamAdminMode>('directory');
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const detailQuery = useTeamDetail(selectedTeamId, true);
  const detail = detailQuery.data?.ok ? detailQuery.data.data : undefined;
  const detailError = detailQuery.data && !detailQuery.data.ok ? detailQuery.data.error.message : null;
  const selectedMember = detail?.team.members.find(member => member.userId === selectedMemberId) ?? null;
  const normalizedSearch = search.trim().toLocaleLowerCase('zh-CN');
  const allTeamIds = new Set(teams.map(team => team.teamId));
  const matchedIds = new Set<string>();
  if (normalizedSearch) {
    for (const team of teams) if ([team.name, team.leaderName].some(value => value.toLocaleLowerCase('zh-CN').includes(normalizedSearch))) matchedIds.add(team.teamId);
    for (const id of [...matchedIds]) {
      let current = teams.find(team => team.teamId === id);
      while (current) {
        const parentId = effectiveTeamParentId(current, allTeamIds);
        if (!parentId) break;
        matchedIds.add(parentId);
        current = teams.find(team => team.teamId === parentId);
      }
    }
  }
  const filteredTeams = normalizedSearch ? teams.filter(team => matchedIds.has(team.teamId)) : [...teams];
  const operations = filteredTeams.filter(isOperations);
  const sales = filteredTeams.filter(team => !isOperations(team));
  const knownTeamIds = new Set(filteredTeams.map(team => team.teamId));
  const directSales = sales.filter(team => effectiveTeamParentId(team, knownTeamIds) === null);
  const unassignedSales = sales.filter(team => (team.assignedLeadCount ?? 0) === 0);
  const selectedTeam = selectedTeamId ? teams.find(team => team.teamId === selectedTeamId) ?? null : null;
  const childCount = sales.length;

  useEffect(() => { setSelectedMemberId(null); }, [selectedTeamId]);

  const changed = () => {
    void detailQuery.refetch();
    onChanged();
  };
  const selectTeam = (teamId: string) => {
    setSelectedMemberId(null);
    onSelect(teamId);
  };
  const memberRows = (teamId: string) => {
    if (selectedTeamId !== teamId) return null;
    if (detailQuery.isLoading) return <div className="team-admin-directory-state">正在读取成员</div>;
    if (detailError) return <div className="team-admin-directory-state is-error">{detailError}</div>;
    if (!detail) return null;
    return <div className="team-admin-member-tree">{detail.team.members.filter(member => member.userId !== identity?.userId).sort((left, right) => Date.parse(right.joinedAt) - Date.parse(left.joinedAt)).map(member => <button key={member.userId} type="button" className={`team-admin-member-tree-row${selectedMemberId === member.userId ? ' is-selected' : ''}`} onClick={() => setSelectedMemberId(member.userId)}>
      <span className="team-admin-member-avatar">{member.displayName.trim().slice(0, 1).toUpperCase() || '?'}</span>
      <span><strong>{member.displayName}</strong><small>{member.role === 'leader' ? '主管' : '成员'} · {member.email || '中心账号'}</small></span>
    </button>)}</div>;
  };
  const toolbar = <div className="team-admin-toolbar">
      <nav className="team-admin-view-tabs" aria-label="团队管理视图">
        <button type="button" aria-current={mode === 'directory' ? 'page' : undefined} onClick={() => setMode('directory')}><ListTree aria-hidden="true" />团队列表</button>
        <button type="button" aria-current={mode === 'canvas' ? 'page' : undefined} onClick={() => setMode('canvas')}><Network aria-hidden="true" />团队画布</button>
      </nav>
      <div className="team-admin-toolbar-actions">
        <div className="team-admin-toolbar-stats"><span><b>{operations.length}</b> 运营组</span><span><b>{childCount}</b> 销售团队</span><span><b>{unassignedSales.length}</b> 未分配线索</span><span><b>{teams.reduce((sum, team) => sum + team.pendingInvitationCount, 0)}</b> 待处理邀请</span></div>
      </div>
    </div>;
  const activityDrawer = <section className="team-admin-activity-drawer is-overview" aria-label="团队动态">
    <div className="team-admin-activity-heading"><div><Activity aria-hidden="true" /><strong>团队动态</strong></div><span>{selectedMember?.displayName ?? selectedTeam?.name ?? '近期'}</span></div>
    <div className="team-admin-activity-list"><div className="team-admin-inline-empty">暂无近期动态</div></div>
  </section>;

  return <div className="team-admin-view">
    {toolbar}
    {mode === 'canvas'
      ? <div className="team-admin-canvas-tab"><TeamOrgCanvas teams={teams} detail={detail} detailLoading={detailQuery.isLoading} selectedTeamId={selectedTeamId} search={search} onSelect={onSelect} /></div>
      : <div className="team-admin-workspace is-directory is-member-directory">
          <aside className="team-admin-rail">
            <div className="team-admin-rail-heading"><div><span>团队结构</span><h2>我的团队</h2></div><small>{filteredTeams.length}</small></div>
            <div className="team-admin-tree">
              {filteredTeams.length === 0 && <div className="team-admin-inline-empty">没有匹配的团队</div>}
              {operations.map(group => {
                const children = sales.filter(team => effectiveTeamParentId(team, knownTeamIds) === group.teamId);
                return <div key={group.teamId} className="team-admin-group">
                  <div className={`team-admin-directory-root${selectedTeamId === group.teamId ? ' is-selected' : ''}`}>
                    <button type="button" className="team-admin-directory-main" onClick={() => selectTeam(group.teamId)}><Building2 aria-hidden="true" /><span><strong>{group.name}</strong><small>{group.leaderName} · {children.length} 个团队</small></span></button>
                  </div>
                  {memberRows(group.teamId)}
                  {children.map(team => <div key={team.teamId}>
                    <button type="button" className={`team-admin-tree-row${selectedTeamId === team.teamId ? ' is-selected' : ''}`} data-depth="1" onClick={() => selectTeam(team.teamId)}>
                      <GitBranch aria-hidden="true" /><span><strong>{team.name}</strong><small>{team.leaderName} · {team.assignedLeadCount ? `已分配 ${team.assignedLeadCount}` : '未分配线索'}</small></span><small>{team.memberCount}</small>
                    </button>
                    {memberRows(team.teamId)}
                  </div>)}
                </div>;
              })}
              {directSales.map(team => <div key={team.teamId}>
                <button type="button" className={`team-admin-tree-row${selectedTeamId === team.teamId ? ' is-selected' : ''}`} data-depth="0" onClick={() => selectTeam(team.teamId)}>
                  <UsersRound aria-hidden="true" /><span><strong>{team.name}</strong><small>{team.leaderName} · 未分配线索</small></span><small>{team.memberCount}</small>
                </button>
                {memberRows(team.teamId)}
              </div>)}
            </div>
          </aside>
          <section className="team-admin-main team-admin-member-main" aria-label={selectedMember ? '成员协作' : '团队详情'}>
            {selectedMember ? <>
              <header className="team-member-collaboration-head">
                <span className="team-member-collaboration-avatar">{selectedMember.displayName.trim().slice(0, 1).toUpperCase() || '?'}</span>
                <span className="team-member-collaboration-identity"><strong>{selectedMember.displayName}</strong><small>{selectedMember.role === 'leader' ? '主管' : '成员'} · {selectedMember.email || '中心账号'}</small><small>{selectedTeam?.name ?? '当前团队'}</small></span>
                <span className={`team-member-connection${online ? ' is-online' : ''}`}>{online ? '中心可达' : '离线'}</span>
              </header>
              <div className="team-collaboration-log" aria-label="成员协作动态">
                <div className="team-collaboration-state">暂无协作动态</div>
              </div>
              <div className="team-collaboration-composer">
                <div className="team-collaboration-tools" aria-label="协作工具">
                  <button type="button" disabled aria-disabled="true" title="团队消息接口尚未接入"><MailPlus aria-hidden="true" />邮件引用</button>
                  <button type="button" disabled aria-disabled="true" title="团队消息接口尚未接入"><BadgeDollarSign aria-hidden="true" />运价确认</button>
                  <button type="button" disabled aria-disabled="true" title="团队消息接口尚未接入"><Eye aria-hidden="true" />关注申请</button>
                  <button type="button" disabled aria-disabled="true" title="团队消息接口尚未接入"><Paperclip aria-hidden="true" />附件</button>
                </div>
                <div className="team-collaboration-composer-box">
                  <textarea rows={2} disabled aria-label="团队消息" placeholder="团队消息暂未开放" />
                  <button type="button" disabled aria-disabled="true" title="团队消息接口尚未接入"><Send aria-hidden="true" />发送</button>
                </div>
              </div>
            </> : <div className={`team-admin-member-detail-content${selectedTeam ? '' : ' is-empty'}`}>
              {selectedTeam
                ? <TeamAdminInspector canManage={canManage} detail={detail} loading={detailQuery.isLoading} error={detailError} onBack={() => onSelect(null)} onChanged={changed} />
                : <div className="team-admin-inline-empty"><Mail aria-hidden="true" />选择成员查看协作动态</div>}
            </div>}
          </section>
          <aside className="team-admin-inspector team-admin-overview-aside">
            <div className="team-admin-overview-main">
              <TeamAdminOverview teams={teams} organization={organization} onSelect={selectTeam} />
            </div>
            {activityDrawer}
          </aside>
        </div>}
  </div>;
}
