import { useState } from 'react';
import { Building2, ChevronRight, GitBranch, ListTree, Network, Plus, Search, UsersRound, X } from 'lucide-react';
import type { OrganizationContext, TeamAdminSummary } from '../../../shared/online-crm';
import { TeamAdminInspector, TeamAdminOverview } from './TeamAdminInspector';
import { TeamOrgCanvas } from './TeamOrgCanvas';
import { useTeamDetail } from './team-data';

type TeamAdminMode = 'directory' | 'canvas';

function isOperations(team: TeamAdminSummary): boolean {
  return team.unitType === 'operations';
}

export function TeamAdminView({ teams, organization, selectedTeamId, canCreate, canCreateChild, onSelect, onCreateTeam, onChanged }: {
  teams: readonly TeamAdminSummary[];
  organization?: OrganizationContext;
  selectedTeamId: string | null;
  canCreate: boolean;
  canCreateChild: boolean;
  onSelect: (teamId: string | null) => void;
  onCreateTeam: (parentTeamId: string | null) => void;
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<TeamAdminMode>('directory');
  const [search, setSearch] = useState('');
  const detailQuery = useTeamDetail(selectedTeamId, true);
  const detail = detailQuery.data?.ok ? detailQuery.data.data : undefined;
  const detailError = detailQuery.data && !detailQuery.data.ok ? detailQuery.data.error.message : null;
  const normalizedSearch = search.trim().toLocaleLowerCase('zh-CN');
  const matchedIds = new Set<string>();
  if (normalizedSearch) {
    for (const team of teams) if ([team.name, team.leaderName].some(value => value.toLocaleLowerCase('zh-CN').includes(normalizedSearch))) matchedIds.add(team.teamId);
    for (const id of [...matchedIds]) {
      let current = teams.find(team => team.teamId === id);
      while (current?.parentTeamId) {
        matchedIds.add(current.parentTeamId);
        current = teams.find(team => team.teamId === current?.parentTeamId);
      }
    }
  }
  const filteredTeams = normalizedSearch ? teams.filter(team => matchedIds.has(team.teamId)) : [...teams];
  const operations = filteredTeams.filter(isOperations);
  const sales = filteredTeams.filter(team => !isOperations(team));
  const operationIds = new Set(operations.map(team => team.teamId));
  const directSales = sales.filter(team => !team.parentTeamId || team.parentTeamId === organization?.company.unitId || !operationIds.has(team.parentTeamId));
  const selectedTeam = selectedTeamId ? teams.find(team => team.teamId === selectedTeamId) ?? null : null;
  const childCount = sales.length;

  const changed = () => {
    void detailQuery.refetch();
    onChanged();
  };

  return <div className="team-admin-view">
    <div className="team-admin-toolbar">
      <div className="team-admin-heading"><span>组织</span><h2>{organization?.company.name ?? '公司'}</h2><small>{operations.length} 个运营组 · {childCount} 个销售团队</small></div>
      <nav className="team-admin-view-tabs" aria-label="团队管理视图">
        <button type="button" aria-current={mode === 'directory' ? 'page' : undefined} onClick={() => setMode('directory')}><ListTree aria-hidden="true" />团队列表</button>
        <button type="button" aria-current={mode === 'canvas' ? 'page' : undefined} onClick={() => setMode('canvas')}><Network aria-hidden="true" />组织画布</button>
      </nav>
      <div className="team-admin-toolbar-actions">
        <label className="team-admin-search">
          <Search aria-hidden="true" />
          <input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索团队或负责人" aria-label="搜索团队或负责人" />
          {search && <button type="button" onClick={() => setSearch('')} aria-label="清除搜索" title="清除搜索"><X aria-hidden="true" /></button>}
        </label>
        {canCreate && <button type="button" className="team-action-primary" onClick={() => onCreateTeam(null)}><Plus aria-hidden="true" />新建组织</button>}
      </div>
    </div>
    {mode === 'canvas'
      ? <div className="team-admin-canvas-tab"><TeamOrgCanvas teams={teams} organization={organization} detail={detail} detailLoading={detailQuery.isLoading} selectedTeamId={selectedTeamId} search={search} onSelect={onSelect} /></div>
      : <div className="team-admin-workspace is-directory">
          <aside className="team-admin-rail">
            <div className="team-admin-company-row"><span className="team-admin-org-icon"><Building2 aria-hidden="true" /></span><span><strong>{organization?.company.name ?? '公司'}</strong><small>{operations.length + directSales.length} 个下级组织</small></span></div>
            <div className="team-admin-tree">
              {filteredTeams.length === 0 && <div className="team-admin-inline-empty">没有匹配的团队</div>}
              {operations.map(group => {
                const children = sales.filter(team => team.parentTeamId === group.teamId);
                return <div key={group.teamId} className="team-admin-group">
                  <button type="button" className={`team-admin-group-row${selectedTeamId === group.teamId ? ' is-selected' : ''}`} onClick={() => onSelect(group.teamId)}>
                    <Building2 aria-hidden="true" /><span><strong>{group.name}</strong><small>{group.leaderName} · {children.length} 个团队</small></span><ChevronRight aria-hidden="true" />
                  </button>
                  {children.map(team => <button key={team.teamId} type="button" className={`team-admin-tree-row${selectedTeamId === team.teamId ? ' is-selected' : ''}`} data-depth="1" onClick={() => onSelect(team.teamId)}>
                    <GitBranch aria-hidden="true" /><span><strong>{team.name}</strong><small>{team.leaderName}</small></span><small>{team.memberCount}</small>
                  </button>)}
                </div>;
              })}
              {directSales.map(team => <button key={team.teamId} type="button" className={`team-admin-tree-row${selectedTeamId === team.teamId ? ' is-selected' : ''}`} data-depth="0" onClick={() => onSelect(team.teamId)}>
                <UsersRound aria-hidden="true" /><span><strong>{team.name}</strong><small>{team.leaderName}</small></span><small>{team.memberCount}</small>
              </button>)}
            </div>
          </aside>
          <aside className="team-admin-inspector">
            {selectedTeam
              ? <TeamAdminInspector
                  detail={detail}
                  teams={teams}
                  organization={organization}
                  loading={detailQuery.isLoading}
                  error={detailError}
                  canCreateChild={canCreateChild}
                  onBack={() => onSelect(null)}
                  onCreateChild={onCreateTeam}
                  onSelect={onSelect}
                  onChanged={changed}
                />
              : <TeamAdminOverview teams={teams} organization={organization} onSelect={onSelect} />}
          </aside>
        </div>}
  </div>;
}
