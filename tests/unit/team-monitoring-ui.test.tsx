// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Identity } from '../../server/core/auth';
import {
  ONLINE_CHANNELS,
  type TeamAdminSummary,
  type TeamMonitoringContactSummary,
  type TeamMonitoringMailDetail,
  type TeamMonitoringMailSummary,
  type TeamMonitoringMemberDetail,
  type TeamMonitoringOverview,
} from '../../src/shared/online-crm';

vi.mock('../../src/renderer/IdentityContext', () => ({
  useIdentity: () => ({ identity: { userId: '55555555-5555-4555-8555-555555555555', displayName: 'Leader', email: 'leader@example.invalid', emailVerified: true, identityAdmin: false, crmRoles: ['sales'] }, baseUrl: 'http://fixture.invalid', status: 'authenticated' }),
  useOptionalIdentity: () => ({ identity: { userId: '55555555-5555-4555-8555-555555555555', displayName: 'Leader', email: 'leader@example.invalid', emailVerified: true, identityAdmin: false, crmRoles: ['sales'] }, baseUrl: 'http://fixture.invalid', status: 'authenticated' }),
}));

vi.mock('antd', async () => {
  const React = await import('react');
  const Button = ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => <button type="button" onClick={onClick}>{children}</button>;
  return {
    Button,
    Drawer: ({ children, open }: { children: React.ReactNode; open: boolean }) => open ? <div className="drawer-fixture">{children}</div> : null,
    Empty: ({ description }: { description: React.ReactNode }) => <div>{description}</div>,
    Pagination: ({ current, onChange }: { current: number; onChange: (page: number) => void }) => <div className="ant-pagination"><button type="button" onClick={() => onChange(current + 1)}>下一页</button></div>,
    Spin: () => <span>读取中</span>,
    Tag: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  };
});

import { TeamMonitoringView } from '../../src/renderer/pages/team/TeamMonitoringView';

const customerId = '11111111-1111-4111-8111-111111111111';
const memberId = '22222222-2222-4222-8222-222222222222';
const teamId = '33333333-3333-4333-8333-333333333333';
const eventId = '44444444-4444-4444-8444-444444444444';
const identity: Identity = { userId: '55555555-5555-4555-8555-555555555555', displayName: 'Leader', email: 'leader@example.invalid', emailVerified: true, identityAdmin: false, crmRoles: ['sales'] };
const team: TeamAdminSummary = { teamId, name: '华东销售组', unitType: 'sales_team', organizationKind: 'sales_team', parentTeamId: null, parentTeamName: '运营组', depth: 1, childCount: 0, leaderName: 'Leader', memberCount: 12, pendingInvitationCount: 0, createdAt: '2026-10-30T00:00:00Z', version: 1 };
const mail: TeamMonitoringMailSummary = { eventId, contactId: 7, customerId, subject: 'Quotation Request', kind: 'replied', direction: 'inbound', occurredAt: '2026-10-30T01:00:00Z', analysisId: 'analysis-1', classification: 'replied', relevance: 'customer_business', summary: '客户询问 40HQ 报价', signals: [], intent: 'quote_request', requiresAction: true, nextAction: '回复报价', priority: 'urgent', confidence: 0.96, source: 'ai', analyzerVersion: 'v1' };
const counts = { contacts: 2, uncontacted: 0, contacted: 1, replied: 1, bounced: 0, autoreply: 0, openActions: 1, overdueActions: 0, importantReplies: 1, openAttention: 1, pendingAssignments: 1, pendingTransfers: 1 };
const rates = { contactRate: 1, replyRate: 0.5, bounceRate: 0, actionRate: 0.5 };
const stages = { cold: 0, reaching: 1, quoting: 1, trial: 0, cooperating: 0, lost: 0, other: 0 };
const overview: TeamMonitoringOverview = {
  scope: 'leader', generatedAt: '2026-10-30T02:00:00Z',
  units: { items: [{ unitId: teamId, name: team.name, kind: 'sales_team', parentUnitId: null, memberCount: 12, counts, rates }], total: 1 },
  members: { items: [{ userId: memberId, displayName: 'Sales One', email: 'sales@example.invalid', teamId, teamName: team.name, organizationKind: 'sales_team', counts, rates, stages, lastActivityAt: '2026-10-30T01:00:00Z', latestImportantReplyAt: '2026-10-30T01:00:00Z' }], total: 11 },
  counts, rates, pool: null, importantReplies: [mail],
};
const member: TeamMonitoringMemberDetail = {
  scope: 'leader', generatedAt: '2026-10-30T02:00:00Z', member: overview.members.items[0]!,
  recentActions: [], attention: [], recentMail: [mail],
};
const contact: TeamMonitoringContactSummary = {
  auditId: '66666666-6666-4666-8666-666666666666', scope: 'leader', contactId: 7, customerId,
  companyId: 9, companyName: 'Atlantic Trade', name: 'Ana Lima', email: 'ana@example.invalid', country: 'BR', title: 'Buyer',
  stage: 'quoting', touchStatus: 'replied', ownerUserId: memberId, ownerName: 'Sales One', origin: 'operations',
  createdAt: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T01:00:00Z', mail: { items: [mail], total: 1 },
};
const mailDetail: TeamMonitoringMailDetail = { auditId: '77777777-7777-4777-8777-777777777777', scope: 'leader', mail };
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('team monitoring renderer', () => {
  let root: Root;
  let host: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.history.replaceState(null, '', '#/team');
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    document.body.innerHTML = '';
  });

  async function mount(invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === ONLINE_CHANNELS.TEAM_MONITORING) return { ok: true as const, data: overview };
    if (channel === ONLINE_CHANNELS.TEAM_MONITORING_MEMBER) return { ok: true as const, data: member };
    if (channel === ONLINE_CHANNELS.TEAM_MONITORING_CONTACT) return { ok: true as const, data: contact };
    if (channel === ONLINE_CHANNELS.TEAM_MONITORING_MAIL) return { ok: true as const, data: mailDetail };
    return { ok: false as const, error: { code: 'UNEXPECTED', message: `${channel}:${args.length}` } };
  })) {
    Object.defineProperty(window, 'api', { configurable: true, value: { invoke } });
    await act(async () => { root.render(<QueryClientProvider client={queryClient}><TeamMonitoringView identity={identity} teams={[team]} online /></QueryClientProvider>); await flush(); });
    await act(flush);
    return invoke;
  }

  it('uses server paging and applies the selected team without filtering rows in the browser', async () => {
    const invoke = await mount();
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.TEAM_MONITORING, expect.objectContaining({ limit: 10, offset: 0, unitLimit: 20 }));
    expect(host.querySelectorAll('.team-monitoring-member-row')).toHaveLength(1);
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="选择监控团队"]')!;
    await act(async () => { select.value = teamId; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(flush);
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.TEAM_MONITORING, expect.objectContaining({ teamId, offset: 0 }));
    await act(async () => host.querySelector<HTMLButtonElement>('.team-monitoring-members .ant-pagination button')!.click());
    await act(flush);
    expect(invoke.mock.calls.some(call => call[0] === ONLINE_CHANNELS.TEAM_MONITORING && (call[1] as { offset?: number }).offset === 10)).toBe(true);
  });

  it('drills into a member, audited contact and structured mail, then links to the customer monitor route', async () => {
    const invoke = await mount();
    await act(async () => host.querySelector<HTMLButtonElement>('.team-monitoring-member-row')!.click());
    await act(flush);
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.TEAM_MONITORING_MEMBER, memberId, 10, 0);
    await act(async () => host.querySelector<HTMLButtonElement>('.team-monitoring-member-detail .team-monitoring-mail-row')!.click());
    await act(flush);
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.TEAM_MONITORING_CONTACT, 7, customerId, 20, 0);
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.TEAM_MONITORING_MAIL, eventId, 7, customerId);
    expect(host.textContent).toContain('客户页监督详情');
    expect(host.textContent).not.toMatch(/编辑|删除|发送|新建任务/);
    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === '客户页监督详情')!.click());
    expect(window.location.hash).toBe(`#/customers?monitorContact=7&centerCustomer=${encodeURIComponent(customerId)}`);
  });
});
