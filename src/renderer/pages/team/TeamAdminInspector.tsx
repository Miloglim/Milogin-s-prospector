import { useDeferredValue, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Building2, ChevronRight, Crown, FolderPlus, GitBranch, MoveRight, Pencil, Plus, Search, Trash2, UserMinus, UserPlus } from 'lucide-react';
import { Modal } from 'antd';
import type { OrganizationContext, Result, TeamAdminSummary, TeamContext, TeamDetail, TeamUnitType } from '../../../shared/online-crm';
import { teamActions, useTeamCandidates } from './team-data';
import { TeamCandidatePicker } from './TeamCandidatePicker';

function key(): string {
  return crypto.randomUUID();
}

function memberInitial(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || '?';
}

function teamType(team: Pick<TeamAdminSummary, 'unitType'> | Pick<TeamDetail['team'], 'unitType'>): TeamUnitType {
  return team.unitType ?? 'sales_team';
}

export function LeaderCandidatePicker({ selected, onChange, unitType, enabled }: {
  selected: string;
  onChange: (userId: string) => void;
  unitType: TeamUnitType;
  enabled: boolean;
}) {
  const [search, setSearch] = useState('');
  const deferred = useDeferredValue(search.trim());
  const query = useTeamCandidates(deferred, enabled, 'leader', unitType);
  const result = query.data;
  const rows = result?.ok ? result.data.items : [];

  return <div className="team-leader-picker">
    <label className="team-field-search"><Search aria-hidden="true" /><input value={search} maxLength={500} onChange={event => setSearch(event.target.value)} placeholder={unitType === 'operations' ? '搜索管理账号' : '搜索销售账号'} /></label>
    {!enabled ? <div className="team-inline-state">联网后可选负责人</div>
      : result && !result.ok ? <div className="team-inline-state is-error">{result.error.message}</div>
        : query.isLoading ? <div className="team-inline-state">正在读取负责人</div>
          : rows.length === 0 ? <div className="team-inline-state">暂无可用负责人</div>
            : <div className="team-candidate-list">{rows.map(row => <label key={row.userId} className="team-candidate-row"><input type="radio" name={`leader-${unitType}`} checked={selected === row.userId} onChange={() => onChange(row.userId)} /><span><strong>{row.displayName}</strong><small>{row.email || '中心账号'}</small></span>{!!row.leaderTeamCount && <em>{row.leaderTeamCount} 个团队</em>}</label>)}</div>}
  </div>;
}

function InvitationRows({ invitations, busy, onCancel }: { invitations: TeamDetail['outgoingInvitations']; busy: boolean; onCancel: (invitation: TeamDetail['outgoingInvitations'][number]) => void }) {
  const sorted = invitations.slice().sort((left, right) => Number(left.status === 'expired') - Number(right.status === 'expired'));
  return <div className="team-admin-invitation-list">{sorted.map(invitation => <div key={invitation.invitationId} className={`team-pending-row${invitation.status === 'expired' ? ' is-expired' : ''}`}><strong>{invitation.inviteeName}</strong><span>{invitation.status === 'expired' ? '已过期' : invitation.status === 'pending' ? '等待接受' : invitation.status}</span>{invitation.canCancel && <button type="button" disabled={busy} onClick={() => onCancel(invitation)}>撤回</button>}</div>)}</div>;
}

export function TeamAdminOverview({ teams, organization, onSelect }: { teams: readonly TeamAdminSummary[]; organization?: OrganizationContext; onSelect: (teamId: string) => void }) {
  const operations = teams.filter(team => teamType(team) === 'operations');
  const sales = teams.filter(team => teamType(team) === 'sales_team');
  const roots = teams.filter(team => !team.parentTeamId || team.parentTeamId === organization?.company.unitId || !teams.some(candidate => candidate.teamId === team.parentTeamId));
  const pendingInvitations = teams.reduce((total, team) => total + team.pendingInvitationCount, 0);
  const memberSeats = sales.reduce((total, team) => total + team.memberCount, 0);
  return <div className="team-admin-overview">
    <div className="team-admin-inspector-title"><div><span>组织</span><h2>{organization?.company.name ?? '公司'}</h2></div></div>
    <div className="team-admin-stat-grid">
      <div><span>运营组</span><strong>{operations.length}</strong></div>
      <div><span>销售团队</span><strong>{sales.length}</strong></div>
      <div><span>成员席位</span><strong>{memberSeats}</strong></div>
      <div><span>待接受</span><strong>{pendingInvitations}</strong></div>
    </div>
    <section className="team-admin-inspector-section">
      <div className="team-section-heading"><div><h3>下级组织</h3><span>{roots.length} 个</span></div></div>
      <div className="team-admin-overview-list">{roots.map(team => <button key={team.teamId} type="button" onClick={() => onSelect(team.teamId)}>
        <span className="team-admin-org-icon">{teamType(team) === 'operations' ? <Building2 aria-hidden="true" /> : <GitBranch aria-hidden="true" />}</span>
        <span><strong>{team.name}</strong><small>{team.leaderName} · {teamType(team) === 'operations' ? `${team.childCount} 个销售团队` : `${team.memberCount} 人`}</small></span>
        <ChevronRight aria-hidden="true" />
      </button>)}</div>
    </section>
  </div>;
}

export function TeamAdminInspector({ detail, teams, organization, loading, error, canCreateChild, onBack, onCreateChild, onSelect, onChanged }: {
  detail: TeamDetail | undefined;
  teams: readonly TeamAdminSummary[];
  organization?: OrganizationContext;
  loading: boolean;
  error: string | null;
  canCreateChild: boolean;
  onBack: () => void;
  onCreateChild: (teamId: string) => void;
  onSelect: (teamId: string) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [moveParentId, setMoveParentId] = useState<string | null>(null);
  const [leaderUserId, setLeaderUserId] = useState('');
  const [addingMembers, setAddingMembers] = useState(false);
  const [memberSelection, setMemberSelection] = useState<string[]>([]);
  const [groupDraft, setGroupDraft] = useState<{ groupId: string | null; name: string; memberIds: string[]; version: number } | null>(null);
  const commandKeys = useRef(new Map<string, string>());
  const team = detail?.team;
  const type = team ? teamType(team) : 'sales_team';
  const companyUnitId = organization?.company.unitId;
  const operationParents = teams.filter(item => teamType(item) === 'operations' && item.teamId !== team?.teamId);

  useEffect(() => {
    if (!team) return;
    setMoveParentId(team.parentTeamId === companyUnitId ? null : team.parentTeamId);
    setLeaderUserId(team.leaderUserId);
    setAddingMembers(false);
    setMemberSelection([]);
    setGroupDraft(null);
    setActionError('');
  }, [team?.teamId, team?.version, team?.parentTeamId, team?.leaderUserId, companyUnitId]);

  const commandKey = (signature: string) => {
    const existing = commandKeys.current.get(signature);
    if (existing) return existing;
    const created = key();
    commandKeys.current.set(signature, created);
    return created;
  };
  const apply = async (signature: string, run: () => Promise<Result<TeamContext>>) => {
    if (busy) return false;
    setBusy(true);
    setActionError('');
    const response = await run();
    setBusy(false);
    if (!response.ok) { setActionError(response.error.message); return false; }
    commandKeys.current.delete(signature);
    onChanged();
    return true;
  };

  if (loading) return <div className="team-page-state team-admin-inspector-state">正在读取团队</div>;
  if (error) return <div className="team-page-state team-admin-inspector-state is-error">{error}</div>;
  if (!detail || !team) return null;

  const members = team.members.filter(member => member.role === 'member');
  const leaders = team.members.filter(member => member.role === 'leader');
  const canCreateSalesTeam = type === 'operations';
  const dissolve = () => {
    const signature = `dissolve:${team.teamId}:${team.version}`;
    Modal.confirm({
      title: `解散 ${team.name}？`,
      content: '成员关系和邀请将结束，联系人归属与历史保留。',
      okText: '解散',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        const changed = await apply(signature, () => teamActions.dissolve(team.teamId, { expectedVersion: team.version, idempotencyKey: commandKey(signature) }));
        if (changed) onBack();
      },
    });
  };

  return <div className="team-admin-inspector-detail">
    <div className="team-admin-detail-toolbar">
      <button type="button" className="team-back-button" onClick={onBack}><ArrowLeft aria-hidden="true" />返回团队树</button>
      <div className="team-form-footer">
        {team.canDissolve && <button type="button" className="team-back-button" disabled={busy} onClick={dissolve}><Trash2 aria-hidden="true" />解散</button>}
        {canCreateChild && canCreateSalesTeam && <button type="button" className="team-action-primary" onClick={() => onCreateChild(team.teamId)}><Plus aria-hidden="true" />新建销售团队</button>}
      </div>
    </div>
    <div className="team-admin-team-head">
      <div><span>{type === 'operations' ? '运营组' : '销售团队'}</span><h2>{team.name}</h2><small>{team.parentTeamName || organization?.company.name || '公司'}</small></div>
      <div><span>负责人</span><strong>{team.leaderName}</strong></div>
      <div><span>{type === 'operations' ? '销售团队' : '成员'}</span><strong>{type === 'operations' ? detail.children.length : team.members.length}{type === 'operations' ? ' 个' : ' 人'}</strong></div>
    </div>

    <section className="team-admin-section team-admin-controls">
      <div className="team-control-row">
        <span><MoveRight aria-hidden="true" />上级</span>
        <select aria-label="移动团队" value={moveParentId ?? ''} onChange={event => setMoveParentId(event.target.value || null)}>
          <option value="">{organization?.company.name ?? '公司'}</option>
          {type === 'sales_team' && operationParents.map(item => <option key={item.teamId} value={item.teamId}>{item.name}</option>)}
        </select>
        <button type="button" disabled={busy || moveParentId === (team.parentTeamId === companyUnitId ? null : team.parentTeamId)} onClick={() => {
          const signature = `move:${team.teamId}:${team.version}:${moveParentId ?? 'root'}`;
          void apply(signature, () => teamActions.move(team.teamId, { parentTeamId: moveParentId, expectedVersion: team.version, idempotencyKey: commandKey(signature) }));
        }}>移动</button>
      </div>
      <div className="team-control-row">
        <span><Crown aria-hidden="true" />主负责人</span>
        <div className="team-control-picker"><LeaderCandidatePicker selected={leaderUserId} onChange={setLeaderUserId} unitType={type} enabled /></div>
        <button type="button" disabled={busy || !leaderUserId || leaderUserId === team.leaderUserId} onClick={() => {
          const signature = `leader:${team.teamId}:${team.version}:${leaderUserId}`;
          void apply(signature, () => teamActions.assignLeader(team.teamId, { leaderUserId, expectedVersion: team.version, idempotencyKey: commandKey(signature) }));
        }}>指定</button>
      </div>
      {actionError && <div className="team-form-error">{actionError}</div>}
    </section>

    {type === 'operations' ? <section className="team-admin-section">
      <div className="team-section-heading"><div><h3>运营负责人</h3><span>{leaders.length} 人</span></div></div>
      <div className="team-admin-member-list">{leaders.map(member => <article key={member.userId} className="team-admin-member-row"><span className="team-admin-member-avatar">{memberInitial(member.displayName)}</span><div><strong>{member.displayName}</strong><small>{member.email || '中心账号'}</small></div><span><Crown aria-hidden="true" />负责人</span></article>)}</div>
    </section> : <>
      <section className="team-admin-section">
        <div className="team-section-heading"><div><h3>团队成员</h3><span>{members.length} 人</span></div><button type="button" className="team-inline-action" onClick={() => setAddingMembers(value => !value)}><UserPlus aria-hidden="true" />添加</button></div>
        {addingMembers && <div className="team-admin-member-add"><TeamCandidatePicker selected={memberSelection} onChange={setMemberSelection} enabled /> <button type="button" className="team-action-primary" disabled={busy || !memberSelection.length} onClick={async () => { const signature = `member-add:${team.teamId}:${team.version}:${memberSelection[0]}`; if (await apply(signature, () => teamActions.adjustMember(team.teamId, { userId: memberSelection[0]!, action: 'add', expectedVersion: team.version, idempotencyKey: commandKey(signature) }))) { setMemberSelection([]); setAddingMembers(false); } }}>加入</button></div>}
        <div className="team-admin-member-list">{members.map(member => <article key={member.userId} className="team-admin-member-row"><span className="team-admin-member-avatar">{memberInitial(member.displayName)}</span><div><strong>{member.displayName}</strong><small>{member.email || '中心账号'}</small></div><button type="button" title="移出团队" aria-label={`移出 ${member.displayName}`} disabled={busy} onClick={() => { const signature = `member-remove:${team.teamId}:${team.version}:${member.userId}`; void apply(signature, () => teamActions.adjustMember(team.teamId, { userId: member.userId, action: 'remove', expectedVersion: team.version, idempotencyKey: commandKey(signature) })); }}><UserMinus aria-hidden="true" /></button></article>)}</div>
      </section>
      <section className="team-admin-section">
        <div className="team-section-heading"><div><h3>展示分组</h3><span>{team.memberGroups?.length ?? 0} 个</span></div><button type="button" className="team-inline-action" onClick={() => setGroupDraft({ groupId: null, name: '', memberIds: [], version: 0 })}><FolderPlus aria-hidden="true" />新建</button></div>
        {!!team.memberGroups?.length && <div className="team-group-list">{team.memberGroups.map(group => <div key={group.groupId} className="team-group-row"><button type="button" onClick={() => setGroupDraft({ groupId: group.groupId, name: group.name, memberIds: group.memberIds, version: group.version })}><Pencil aria-hidden="true" /><span><strong>{group.name}</strong><small>{group.memberIds.length} 人</small></span></button><button type="button" aria-label={`删除 ${group.name}`} title="删除分组" disabled={busy} onClick={() => { const signature = `group-delete:${team.teamId}:${team.version}:${group.groupId}:${group.version}`; void apply(signature, () => teamActions.deleteMemberGroup(team.teamId, group.groupId, { groupId: group.groupId, expectedVersion: group.version, idempotencyKey: commandKey(signature) })); }}><Trash2 aria-hidden="true" /></button></div>)}</div>}
        {groupDraft && <div className="team-group-editor"><input value={groupDraft.name} maxLength={40} onChange={event => setGroupDraft({ ...groupDraft, name: event.target.value })} placeholder="分组名称" /><div className="team-group-members">{members.map(member => <label key={member.userId}><input type="checkbox" checked={groupDraft.memberIds.includes(member.userId)} onChange={() => setGroupDraft({ ...groupDraft, memberIds: groupDraft.memberIds.includes(member.userId) ? groupDraft.memberIds.filter(id => id !== member.userId) : [...groupDraft.memberIds, member.userId] })} />{member.displayName}</label>)}</div><div className="team-form-footer"><button type="button" onClick={() => setGroupDraft(null)}>取消</button><button type="button" className="team-action-primary" disabled={busy || !groupDraft.name.trim()} onClick={async () => { const signature = `group-save:${team.teamId}:${team.version}:${groupDraft.groupId ?? 'new'}:${groupDraft.version}:${groupDraft.name.trim()}:${groupDraft.memberIds.slice().sort().join(',')}`; if (await apply(signature, () => teamActions.saveMemberGroup(team.teamId, { groupId: groupDraft.groupId, name: groupDraft.name.trim(), memberIds: groupDraft.memberIds, expectedVersion: groupDraft.version, idempotencyKey: commandKey(signature) }))) setGroupDraft(null); }}>保存</button></div></div>}
      </section>
    </>}

    <section className="team-admin-section">
      <div className="team-section-heading"><div><h3>{type === 'operations' ? '下属销售团队' : '下级团队'}</h3><span>{detail.children.length} 个</span></div></div>
      {detail.children.length === 0
        ? <div className="team-admin-inline-empty">暂无下级团队</div>
        : <div className="team-admin-tree compact">{detail.children.map(child => <button key={child.teamId} type="button" className="team-admin-tree-row" onClick={() => onSelect(child.teamId)}>
          <GitBranch aria-hidden="true" /><span><strong>{child.name}</strong><small>负责人 {child.leaderName}</small></span><small>{child.memberCount} 人</small><ChevronRight aria-hidden="true" />
        </button>)}</div>}
    </section>
    {detail.outgoingInvitations.length > 0 && <section className="team-admin-section">
      <div className="team-section-heading"><div><h3>成员邀请</h3><span>{detail.outgoingInvitations.filter(item => item.status === 'pending').length} 个待接受</span></div></div>
      <InvitationRows invitations={detail.outgoingInvitations} busy={busy} onCancel={invitation => { const signature = `invite-cancel:${invitation.invitationId}:${invitation.version}`; void apply(signature, () => teamActions.cancel(invitation.invitationId, { expectedVersion: invitation.version, idempotencyKey: commandKey(signature) })); }} />
    </section>}
  </div>;
}
