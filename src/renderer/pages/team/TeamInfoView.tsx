import { useRef, useState } from 'react';
import { Crown, MailPlus, Trash2, UserRound } from 'lucide-react';
import { Modal } from 'antd';
import type { TeamAdminSummary, TeamInvitation, TeamSnapshot } from '../../../shared/online-crm';
import { teamActions } from './team-data';
import { TeamCandidatePicker } from './TeamCandidatePicker';

function key(): string {
  return crypto.randomUUID();
}

export function TeamInfoView({ team, outgoingInvitations, managedTeams, selectedTeamId, onSelectTeam, canInvite, online, onChanged, onDissolved }: {
  team: TeamSnapshot;
  outgoingInvitations: TeamInvitation[];
  managedTeams: TeamAdminSummary[];
  selectedTeamId: string;
  onSelectTeam: (teamId: string) => void;
  canInvite: boolean;
  online: boolean;
  onChanged: () => void;
  onDissolved: () => void;
}) {
  const [inviting, setInviting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [inviteKey, setInviteKey] = useState(key);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const commandKeys = useRef(new Map<string, string>());
  const commandKey = (signature: string) => {
    const existing = commandKeys.current.get(signature);
    if (existing) return existing;
    const created = key();
    commandKeys.current.set(signature, created);
    return created;
  };
  const changeSelected = (ids: string[]) => { setSelected(ids); setInviteKey(key()); };
  const invite = async () => {
    if (!selected.length || busy) return;
    setBusy(true);
    setError('');
    const result = await teamActions.invite(team.teamId, { userIds: selected, idempotencyKey: inviteKey });
    setBusy(false);
    if (!result.ok) { setError(result.error.message); return; }
    setSelected([]);
    setInviteKey(key());
    setInviting(false);
    onChanged();
  };
  const dissolve = () => {
    const signature = `dissolve:${team.teamId}:${team.version}`;
    Modal.confirm({
      title: `解散 ${team.name}？`,
      content: '成员关系和邀请将结束，联系人归属与历史保留。',
      okText: '解散',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        setBusy(true);
        setError('');
        const result = await teamActions.dissolve(team.teamId, { expectedVersion: team.version, idempotencyKey: commandKey(signature) });
        setBusy(false);
        if (!result.ok) { setError(result.error.message); return; }
        commandKeys.current.delete(signature);
        onDissolved();
      },
    });
  };

  const memberCount = team.memberCount ?? team.members.length;
  const leaders = team.members.filter(member => member.role === 'leader');
  const regular = team.members.filter(member => member.role === 'member');
  const grouped = new Set((team.memberGroups ?? []).flatMap(group => group.memberIds));
  const ungrouped = regular.filter(member => !grouped.has(member.userId));
  const memberRow = (member: TeamSnapshot['members'][number]) => <article key={member.userId} className="team-member-row"><span className="team-member-avatar">{member.role === 'leader' ? <Crown aria-hidden="true" /> : <UserRound aria-hidden="true" />}</span><div><strong>{member.displayName}</strong><small>{member.email || '中心账号'}</small></div><span>{member.role === 'leader' ? '负责人' : '成员'}</span></article>;

  return <div className="team-info-view">
    <div className="team-info-head"><div><span>团队</span><h2>{team.name}</h2><small>{team.parentTeamName ? `上级团队：${team.parentTeamName}` : '根团队'}</small></div><div><span>负责人</span><strong>{team.leaderName}</strong></div><div><span>成员</span><strong>{memberCount} 人</strong></div>{(team.canDissolve || canInvite) && <span className="team-form-footer" style={{ marginLeft: 'auto' }}>{team.canDissolve && <button type="button" className="team-action-secondary" disabled={!online || busy} onClick={dissolve}><Trash2 aria-hidden="true" />解散</button>}{canInvite && <button type="button" className="team-action-primary" disabled={!online || inviting} onClick={() => setInviting(value => !value)}><MailPlus aria-hidden="true" />邀请成员</button>}</span>}</div>
    {managedTeams.length > 1 && <section className="team-managed-panel"><div className="team-section-heading"><div><h2>负责团队</h2><span>{managedTeams.length} 个</span></div></div><label className="team-managed-switcher"><span>当前团队</span><select value={selectedTeamId} onChange={event => onSelectTeam(event.target.value)}>{managedTeams.map(item => <option key={item.teamId} value={item.teamId}>{item.name} · {item.memberCount} 人</option>)}</select></label></section>}
    {inviting && canInvite && <section className="team-invite-panel"><TeamCandidatePicker selected={selected} onChange={changeSelected} enabled={online} /><div className="team-form-footer"><button type="button" className="team-action-primary" disabled={!online || busy || !selected.length} onClick={() => void invite()}>{busy ? '处理中' : `发送邀请${selected.length ? `（${selected.length}）` : ''}`}</button></div></section>}
    {error && <div className="team-form-error">{error}</div>}
    <section className="team-members-panel"><div className="team-section-heading"><div><h2>团队成员</h2><span>{memberCount} 人</span></div></div>{leaders.length > 0 && <div className="team-member-list">{leaders.map(memberRow)}</div>}{(team.memberGroups ?? []).map(group => {
      const rows = regular.filter(member => group.memberIds.includes(member.userId));
      return rows.length > 0 ? <details key={group.groupId} className="team-member-group" open><summary><strong>{group.name}</strong><span>{rows.length} 人</span></summary><div className="team-member-list">{rows.map(memberRow)}</div></details> : null;
    })}{ungrouped.length > 0 && <details className="team-member-group" open><summary><strong>未分组</strong><span>{ungrouped.length} 人</span></summary><div className="team-member-list">{ungrouped.map(memberRow)}</div></details>}</section>
    {outgoingInvitations.length > 0 && <section className="team-pending-panel"><div className="team-section-heading"><div><h2>成员邀请</h2><span>{outgoingInvitations.filter(item => item.status === 'pending').length} 个待接受</span></div></div>{outgoingInvitations.map(invitation => <article key={invitation.invitationId} className={`team-pending-row${invitation.status === 'expired' ? ' is-expired' : ''}`}><strong>{invitation.inviteeName}</strong><span>{invitation.status === 'expired' ? '已过期' : invitation.status === 'pending' ? '等待接受' : invitation.status}</span>{invitation.canCancel && <button type="button" disabled={!online || busy} onClick={async () => { const signature = `cancel:${invitation.invitationId}:${invitation.version}`; setBusy(true); setError(''); const result = await teamActions.cancel(invitation.invitationId, { expectedVersion: invitation.version, idempotencyKey: commandKey(signature) }); setBusy(false); if (result.ok) { commandKeys.current.delete(signature); onChanged(); } else setError(result.error.message); }}>撤回</button>}</article>)}</section>}
  </div>;
}
