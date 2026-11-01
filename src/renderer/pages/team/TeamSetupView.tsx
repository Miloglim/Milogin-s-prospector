import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Building2, Check, UserPlus, UsersRound, X } from 'lucide-react';
import type { TeamContext, TeamCreateReceipt, TeamUnitType } from '../../../shared/online-crm';
import { teamActions } from './team-data';
import { LeaderCandidatePicker } from './TeamAdminInspector';
import { TeamCandidatePicker } from './TeamCandidatePicker';

function key(): string {
  return crypto.randomUUID();
}

function unitName(context: TeamContext, teamId: string | null): string {
  if (!teamId) return context.organization?.company.name ?? '公司';
  return context.adminTeams.find(team => team.teamId === teamId)?.name ?? '公司';
}

export function TeamSetupView({ context, online, parentTeamId: initialParentTeamId, onBack, onContext, onCreated }: {
  context: TeamContext;
  online: boolean;
  parentTeamId?: string | null;
  onBack?: () => void;
  onContext: (next: TeamContext) => void;
  onCreated: (receipt: TeamCreateReceipt) => void;
}) {
  const manager = context.canAdmin;
  const initialParent = initialParentTeamId ? context.adminTeams.find(team => team.teamId === initialParentTeamId) : null;
  const initialType: TeamUnitType = manager && initialParent?.unitType !== 'operations' ? 'operations' : 'sales_team';
  const [unitType, setUnitType] = useState<TeamUnitType>(initialType);
  const [name, setName] = useState('');
  const [parentTeamId, setParentTeamId] = useState<string | null>(initialParentTeamId ?? null);
  const [leaderUserId, setLeaderUserId] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [createKey, setCreateKey] = useState(key);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const decisionKeys = useRef(new Map<string, string>());
  const parentOptions = useMemo(() => context.adminTeams.filter(team => (team.unitType ?? 'sales_team') === 'operations'), [context.adminTeams]);

  useEffect(() => {
    const parent = initialParentTeamId ? context.adminTeams.find(team => team.teamId === initialParentTeamId) : null;
    setParentTeamId(initialParentTeamId ?? null);
    setUnitType(manager && parent?.unitType !== 'operations' ? 'operations' : 'sales_team');
    setLeaderUserId('');
    setSelected([]);
    setCreateKey(key());
  }, [initialParentTeamId, manager]);

  const resetKey = () => setCreateKey(key());
  const changeType = (next: TeamUnitType) => {
    setUnitType(next);
    if (next === 'operations') setParentTeamId(null);
    setLeaderUserId('');
    setSelected([]);
    resetKey();
  };
  const create = async () => {
    if (!name.trim() || busy || !context.canCreate || manager && !leaderUserId) return;
    setBusy(true);
    setError('');
    const result = await teamActions.create({
      name: name.trim(),
      parentTeamId: manager ? parentTeamId : null,
      unitType: manager ? unitType : 'sales_team',
      leaderUserId: manager ? leaderUserId : undefined,
      inviteeUserIds: unitType === 'sales_team' ? selected : [],
      idempotencyKey: createKey,
    });
    setBusy(false);
    if (!result.ok) { setError(result.error.message); return; }
    setName('');
    setLeaderUserId('');
    setSelected([]);
    setCreateKey(key());
    onCreated(result.data);
  };
  const decide = async (invitationId: string, expectedVersion: number, action: 'accept' | 'decline') => {
    if (busy || !online) return;
    setBusy(true);
    setError('');
    const signature = `${action}:${invitationId}:${expectedVersion}`;
    const idempotencyKey = decisionKeys.current.get(signature) ?? key();
    decisionKeys.current.set(signature, idempotencyKey);
    const input = { expectedVersion, idempotencyKey };
    const result = action === 'accept' ? await teamActions.accept(invitationId, input) : await teamActions.decline(invitationId, input);
    setBusy(false);
    if (!result.ok) { setError(result.error.message); return; }
    decisionKeys.current.delete(signature);
    onContext(result.data);
  };

  return <div className="team-setup-view">
    <div className="team-page-nav-row">{onBack && <button type="button" className="team-back-button" onClick={onBack}><ArrowLeft aria-hidden="true" />返回团队树</button>}</div>
    {!online && <div className="team-page-notice">联网后可创建团队或处理邀请</div>}
    {context.incomingInvitations.length > 0 && <section className="team-setup-section">
      <div className="team-section-heading"><div><h2>成员邀请</h2><span>{context.incomingInvitations.filter(item => item.status === 'pending').length} 个待处理</span></div></div>
      <div className="team-invitation-list">{context.incomingInvitations.map(invitation => {
        const expired = invitation.status === 'expired';
        return <article key={invitation.invitationId} className={`team-invitation-row${expired ? ' is-expired' : ''}`}>
          <span className="team-invitation-icon"><UserPlus aria-hidden="true" /></span>
          <div><strong>{invitation.teamName}</strong><small>{expired ? '邀请已过期' : `${invitation.inviterName} 邀请你加入`}</small></div>
          <div className="team-invitation-actions">
            {expired ? <span className="team-status-chip">已过期</span> : <>
              <button type="button" className="team-action-primary" disabled={!online || busy || !invitation.canAccept} onClick={() => void decide(invitation.invitationId, invitation.version, 'accept')}><Check aria-hidden="true" />接受</button>
              <button type="button" className="team-action-secondary" disabled={!online || busy || !invitation.canDecline} onClick={() => void decide(invitation.invitationId, invitation.version, 'decline')}><X aria-hidden="true" />拒绝</button>
            </>}
          </div>
        </article>;
      })}</div>
    </section>}
    {context.canCreate && <section className="team-setup-section">
      <div className="team-section-heading"><div><h2>{manager ? '创建组织' : '创建团队'}</h2></div></div>
      <div className="team-create-form">
        {manager && <div className="team-create-type" role="group" aria-label="组织类型">
          <button type="button" aria-pressed={unitType === 'operations'} onClick={() => changeType('operations')}><Building2 aria-hidden="true" />运营组</button>
          <button type="button" aria-pressed={unitType === 'sales_team'} onClick={() => changeType('sales_team')}><UsersRound aria-hidden="true" />销售团队</button>
        </div>}
        <label><span>名称</span><input value={name} maxLength={80} onChange={event => { setName(event.target.value); resetKey(); }} placeholder={unitType === 'operations' ? '运营组名称' : '团队名称'} /></label>
        {manager && <label><span>上级</span><select value={parentTeamId ?? ''} onChange={event => { setParentTeamId(event.target.value || null); resetKey(); }}>
          <option value="">{unitName(context, null)}</option>
          {unitType === 'sales_team' && parentOptions.map(team => <option key={team.teamId} value={team.teamId}>{team.name}</option>)}
        </select></label>}
        {manager && <div className="team-create-members"><span>负责人</span><LeaderCandidatePicker selected={leaderUserId} onChange={value => { setLeaderUserId(value); resetKey(); }} unitType={unitType} enabled={online} /></div>}
        {(!manager || unitType === 'sales_team') && <div className="team-create-members"><span>邀请成员</span><TeamCandidatePicker selected={selected} onChange={ids => { setSelected(ids); resetKey(); }} enabled={online} /></div>}
        {error && <div className="team-form-error">{error}</div>}
        <div className="team-form-footer">{onBack && <button type="button" className="team-action-secondary" disabled={busy} onClick={onBack}>取消</button>}<button type="button" className="team-action-primary" disabled={!online || busy || !name.trim() || manager && !leaderUserId} onClick={() => void create()}>{busy ? '处理中' : manager ? '创建组织' : '创建团队'}</button></div>
      </div>
    </section>}
  </div>;
}
