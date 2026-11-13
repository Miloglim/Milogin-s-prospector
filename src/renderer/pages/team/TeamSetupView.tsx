import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Building2, Check, UserPlus, UsersRound, X } from 'lucide-react';
import type { TeamContext, TeamCreateReceipt, TeamUnitType } from '../../../shared/online-crm';
import { useIdentity } from '../../IdentityContext';
import { teamActions } from './team-data';
import { LeaderCandidatePicker } from './TeamAdminInspector';
import { TeamCandidatePicker } from './TeamCandidatePicker';

function key(): string {
  return crypto.randomUUID();
}

export function TeamSetupView({ context, online, onBack, onContext, onCreated }: {
  context: TeamContext;
  online: boolean;
  onBack?: () => void;
  onContext: (next: TeamContext) => void;
  onCreated: (receipt: TeamCreateReceipt) => void;
}) {
  const { identity } = useIdentity();
  const manager = context.canAdmin;
  const canCreateOperations = context.isSuperAdmin || !!identity?.crmRoles.includes('operations');
  const canCreateSales = context.isSuperAdmin || !!identity?.crmRoles.includes('sales');
  const availableTypes: TeamUnitType[] = [canCreateOperations ? 'operations' : null, canCreateSales ? 'sales_team' : null].filter((value): value is TeamUnitType => !!value);
  const initialType: TeamUnitType = canCreateOperations ? 'operations' : 'sales_team';
  const [unitType, setUnitType] = useState<TeamUnitType>(initialType);
  const [name, setName] = useState('');
  const [leaderUserId, setLeaderUserId] = useState(manager ? identity?.userId ?? '' : '');
  const [selected, setSelected] = useState<string[]>([]);
  const [createKey, setCreateKey] = useState(key);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const decisionKeys = useRef(new Map<string, string>());
  const creator = identity ? { userId: identity.userId, displayName: identity.displayName, email: identity.email } : null;
  const activeUnitType: TeamUnitType = availableTypes.includes(unitType) ? unitType : initialType;

  useEffect(() => {
    setUnitType(initialType);
    setLeaderUserId(manager ? identity?.userId ?? '' : '');
    setSelected([]);
    setCreateKey(key());
  }, [identity?.userId, manager, initialType]);

  const resetKey = () => setCreateKey(key());
  const changeType = (next: TeamUnitType) => {
    setUnitType(next);
    setSelected([]);
    resetKey();
  };
  const create = async () => {
    if (!name.trim() || busy || !context.canCreate || manager && !leaderUserId) return;
    setBusy(true);
    setError('');
    const result = await teamActions.create({
      name: name.trim(),
      parentTeamId: null,
      unitType: activeUnitType,
      leaderUserId: manager ? leaderUserId : undefined,
      inviteeUserIds: activeUnitType === 'sales_team' ? selected : [],
      idempotencyKey: createKey,
    });
    setBusy(false);
    if (!result.ok) { setError(result.error.message); return; }
    setName('');
    setLeaderUserId(manager ? identity?.userId ?? '' : '');
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
      <div className="team-section-heading"><div><h2>创建团队</h2></div></div>
      <div className="team-create-form">
        {availableTypes.length > 1 && <div className="team-create-type" role="group" aria-label="团队类型">
          <button type="button" aria-pressed={activeUnitType === 'operations'} onClick={() => changeType('operations')}><Building2 aria-hidden="true" />运营组</button>
          <button type="button" aria-pressed={activeUnitType === 'sales_team'} onClick={() => changeType('sales_team')}><UsersRound aria-hidden="true" />销售团队</button>
        </div>}
        <label><span>名称</span><input value={name} maxLength={80} onChange={event => { setName(event.target.value); resetKey(); }} placeholder={activeUnitType === 'operations' ? '运营组名称' : '团队名称'} /></label>
        {manager && <div className="team-create-members"><span>负责人</span><LeaderCandidatePicker selected={leaderUserId} onChange={value => { setLeaderUserId(value); resetKey(); }} unitType={activeUnitType} enabled={online} lockedUser={creator} /></div>}
        {(!manager || activeUnitType === 'sales_team') && <div className="team-create-members"><span>邀请成员</span><TeamCandidatePicker selected={selected} onChange={ids => { setSelected(ids); resetKey(); }} enabled={online} purpose="create" /></div>}
        {error && <div className="team-form-error">{error}</div>}
        <div className="team-form-footer">{onBack && <button type="button" className="team-action-secondary" disabled={busy} onClick={onBack}>取消</button>}<button type="button" className="team-action-primary" disabled={!online || busy || !name.trim() || manager && !leaderUserId} onClick={() => void create()}>{busy ? '处理中' : '创建团队'}</button></div>
      </div>
    </section>}
  </div>;
}
