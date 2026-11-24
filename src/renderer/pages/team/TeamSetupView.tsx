import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, ChevronDown, Plus, UserPlus, UsersRound, X } from 'lucide-react';
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
  const businessRoles = identity?.crmRoles ?? [];
  const activeUnitType: TeamUnitType | null = !identity?.identityAdmin && businessRoles.length === 1
    ? businessRoles[0] === 'operations' ? 'operations' : businessRoles[0] === 'sales' ? 'sales_team' : null
    : null;
  const canCreateBusiness = context.canCreate && !!activeUnitType;
  const [name, setName] = useState('');
  const [leaderUserId, setLeaderUserId] = useState(manager ? identity?.userId ?? '' : '');
  const [selected, setSelected] = useState<string[]>([]);
  const [membersOpen, setMembersOpen] = useState(false);
  const [createKey, setCreateKey] = useState(key);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const decisionKeys = useRef(new Map<string, string>());
  const creator = identity ? { userId: identity.userId, displayName: identity.displayName, email: identity.email } : null;

  useEffect(() => {
    setLeaderUserId(manager ? identity?.userId ?? '' : '');
    setSelected([]);
    setMembersOpen(false);
    setCreateKey(key());
  }, [identity?.userId, manager]);

  const resetKey = () => setCreateKey(key());
  const create = async () => {
    if (!name.trim() || busy || !canCreateBusiness || !activeUnitType || manager && !leaderUserId) return;
    setBusy(true);
    setError('');
    const result = await teamActions.create({
      name: name.trim(),
      parentTeamId: null,
      unitType: activeUnitType,
      leaderUserId: manager ? leaderUserId : undefined,
      inviteeUserIds: selected,
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

  const pendingInvitations = context.incomingInvitations.filter(item => item.status === 'pending').length;
  const teamLabel = activeUnitType === 'operations' ? '运营组' : '销售团队';
  return <div className={`team-setup-view${context.canCreate ? '' : ' is-invite-only'}`}>
    {onBack && <div className="team-page-nav-row"><button type="button" className="team-back-button" onClick={onBack}><ArrowLeft aria-hidden="true" />返回团队树</button></div>}
    {!online && <div className="team-page-notice">联网后可创建团队或处理邀请</div>}
    {online && context.canCreate && !activeUnitType && <div className="team-page-notice">账号角色需要调整为单一管理员或普通用户后才能创建团队</div>}
    <div className="team-setup-header"><span className="team-setup-header-icon"><UsersRound aria-hidden="true" /></span><div><h1>团队</h1>{pendingInvitations > 0 && <span>{pendingInvitations} 个待处理邀请</span>}</div></div>
    <div className={`team-setup-grid${canCreateBusiness ? '' : ' is-single'}`}>
      {canCreateBusiness && activeUnitType && <section className="team-setup-section team-create-section">
        <div className="team-section-heading"><div><h2>创建团队</h2><span>{teamLabel}</span></div></div>
        <div className="team-create-form">
          <div className={`team-create-fields${manager ? '' : ' is-name-only'}`}>
            <label><span>名称</span><input value={name} maxLength={80} onChange={event => { setName(event.target.value); resetKey(); }} placeholder={activeUnitType === 'operations' ? '例如：华东运营组' : '例如：华东销售一组'} /></label>
            {manager && <div className="team-create-members"><span>负责人</span><LeaderCandidatePicker selected={leaderUserId} onChange={value => { setLeaderUserId(value); resetKey(); }} unitType={activeUnitType} enabled={online} lockedUser={creator} /></div>}
          </div>
          <div className="team-create-members team-create-invite">
            <button type="button" className="team-invite-disclosure" aria-expanded={membersOpen} onClick={() => setMembersOpen(value => !value)}>
              <Plus aria-hidden="true" /><span>添加初始成员</span><em>{selected.length ? `已选 ${selected.length} 人` : '可选'}</em><ChevronDown aria-hidden="true" />
            </button>
            {membersOpen && <TeamCandidatePicker selected={selected} onChange={ids => { setSelected(ids); resetKey(); }} enabled={online} unitType={activeUnitType} purpose="create" />}
          </div>
          {error && <div className="team-form-error">{error}</div>}
          <div className="team-form-footer">{onBack && <button type="button" className="team-action-secondary" disabled={busy} onClick={onBack}>取消</button>}<button type="button" className="team-action-primary" disabled={!online || busy || !name.trim() || manager && !leaderUserId} onClick={() => void create()}>{busy ? '处理中' : '创建团队'}</button></div>
        </div>
      </section>}
      {(!canCreateBusiness || context.incomingInvitations.length > 0) && <section className="team-setup-section team-invite-inbox">
        <div className="team-section-heading"><div><h2>邀请</h2>{pendingInvitations > 0 && <span>{pendingInvitations} 个待处理</span>}</div></div>
        {context.incomingInvitations.length > 0
          ? <div className="team-invitation-list">{context.incomingInvitations.map(invitation => {
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
          : <div className="team-setup-empty is-compact"><span className="team-setup-empty-icon"><UserPlus aria-hidden="true" /></span><strong>暂无邀请</strong></div>}
      </section>}
    </div>
  </div>;
}
