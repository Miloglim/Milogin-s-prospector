// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamDetail } from '../../src/shared/online-crm';
import { TeamAdminInspector } from '../../src/renderer/pages/team/TeamAdminInspector';

vi.mock('antd', () => ({ Modal: { confirm: vi.fn() } }));

const teamId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const leaderId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const detail: TeamDetail = {
  team: {
    teamId,
    name: '销售一组',
    unitType: 'sales_team',
    parentTeamId: null,
    parentTeamName: null,
    leaderUserId: leaderId,
    leaderName: '负责人',
    version: 1,
    createdAt: '2026-01-01T00:00:00Z',
    members: [
      { userId: leaderId, displayName: '负责人', email: 'leader@example.invalid', role: 'leader', joinedAt: '2026-01-01T00:00:00Z' },
      { userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', displayName: '较早成员', email: 'old@example.invalid', role: 'member', joinedAt: '2026-02-01T00:00:00Z' },
      { userId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', displayName: '最新成员', email: 'new@example.invalid', role: 'member', joinedAt: '2026-03-01T00:00:00Z' },
    ],
    memberGroups: [],
  },
  outgoingInvitations: [
    { invitationId: '11111111-1111-4111-8111-111111111111', teamId, teamName: '销售一组', inviterUserId: leaderId, inviterName: '负责人', inviteeUserId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', inviteeName: '较早邀请', status: 'pending', version: 1, createdAt: '2026-02-01T00:00:00Z', decidedAt: null, canAccept: false, canDecline: false, canCancel: true },
    { invitationId: '22222222-2222-4222-8222-222222222222', teamId, teamName: '销售一组', inviterUserId: leaderId, inviterName: '负责人', inviteeUserId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', inviteeName: '最新邀请', status: 'expired', version: 1, createdAt: '2026-03-01T00:00:00Z', decidedAt: '2026-03-02T00:00:00Z', canAccept: false, canDecline: false, canCancel: false },
  ],
  children: [],
};

describe('team admin chronological lists', () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('keeps members and invitations newest first even when the server payload is unsorted', async () => {
    await act(async () => root.render(<TeamAdminInspector canManage detail={detail} loading={false} error={null} onBack={vi.fn()} onChanged={vi.fn()} />));
    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === '管理')!.click());

    expect(Array.from(host.querySelectorAll('.team-admin-member-row strong')).map(node => node.textContent)).toEqual(['最新成员', '较早成员']);
    expect(Array.from(host.querySelectorAll('.team-pending-row strong')).map(node => node.textContent)).toEqual(['最新邀请', '较早邀请']);
  });
});
