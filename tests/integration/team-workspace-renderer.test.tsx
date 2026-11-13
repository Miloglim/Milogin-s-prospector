// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Identity } from '../../server/core/auth';
import { ONLINE_CHANNELS, TEAM_ATTENTION_EVENTS, type CenterContact, type FollowupTask, type OnlineNotification, type OrganizationContext, type Result, type SalesPerformanceOverview, type TeamAdminSummary, type TeamAttentionItem, type TeamAttentionPage, type TeamContext, type TeamMonitoringMemberDetail, type TeamMonitoringOverview } from '../../src/shared/online-crm';

const identityState = vi.hoisted(() => ({ identity: null as Record<string, unknown> | null, status: 'authenticated', baseUrl: 'https://center.test' }));
vi.mock('../../src/renderer/IdentityContext', () => ({
  useIdentity: () => identityState,
  useOptionalIdentity: () => identityState,
}));

import { TeamWorkspace } from '../../src/renderer/pages/team/TeamWorkspace';
import { notificationResourceHash } from '../../src/renderer/components/MessageCenterPanel';
import { NotificationProvider, useOptionalNotifications } from '../../src/renderer/NotificationContext';

const sales: Identity = { userId: 'sales-1', displayName: 'Sales One', email: 'sales@example.invalid', emailVerified: true, identityAdmin: false, crmRoles: ['sales'], crmCapabilities: ['leads.develop', 'leads.claim'] };
const leader: Identity = { ...sales, userId: 'leader-1', displayName: 'Team Leader', email: 'leader@example.invalid' };
const operations: Identity = { userId: 'operations-1', displayName: 'Operations One', email: 'ops@example.invalid', emailVerified: true, identityAdmin: false, crmRoles: ['operations'], crmCapabilities: ['leads.assign', 'leads.develop', 'members.read'] };
const auditor: Identity = { userId: 'auditor-1', displayName: 'Auditor', email: 'audit@example.invalid', emailVerified: true, identityAdmin: false, crmRoles: ['auditor'] };
const contact = {
  contactId: 7, customerId: '12345678-1234-1234-1234-123456789abc', customerVersion: 2, contactVersion: 1,
  companyId: 3, companyName: 'Atlantic Trade', email: 'ana@example.invalid', firstName: 'Ana', lastName: 'Lima',
  title: 'Buyer', phone: null, whatsapp: null, linkedinUrl: null, country: 'Brazil', clientType: 'agent', language: 'en',
  stage: 'f2', status: '', tags: [], extra: {}, touchStatus: 'replied', relationshipStage: 'quoting', assignee: '',
  source: 'fixture', sourceDetail: null, sourceLevel1: null, sourceLevel2: null, createdAt: '2026-10-29T00:00:00Z', updatedAt: '2026-10-29T02:00:00Z',
  ownerUserId: 'sales-1', ownerName: 'Sales One', origin: 'personal', state: 'owned', lastFollowupAt: '2026-10-29T02:00:00Z',
} as CenterContact;
const task = { taskId: 'task-1', customerId: contact.customerId, title: '回复海运费报价', dueAt: '2026-10-30T02:00:00Z', status: 'open', version: 1, responsibleUserId: sales.userId, responsibleName: sales.displayName, createdBy: sales.userId, createdAt: '2026-10-29T00:00:00Z', updatedAt: '2026-10-29T00:00:00Z', completedAt: null, completedBy: null, feedback: null, canManage: true } as FollowupTask;
const superAdmin: Identity = { userId: 'admin-1', displayName: 'Super Admin', email: 'admin@example.invalid', emailVerified: true, identityAdmin: true, crmRoles: ['admin'], crmCapabilities: ['leads.read.all'] };
const companyId = '11111111-1111-4111-8111-111111111111';
const operationsGroupId = '99999999-9999-4999-8999-999999999999';
const organization: OrganizationContext = {
  company: { unitId: companyId, kind: 'company', parentUnitId: null, name: 'Milogin Logistics', version: 1 },
  visibleUnits: [],
};
const team = { teamId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: '华东销售组', unitType: 'sales_team' as const, parentTeamId: operationsGroupId, parentTeamName: '华东运营组', assignmentSourceTeamIds: [operationsGroupId], assignedLeadCount: 3, leaderUserId: leader.userId, leaderName: leader.displayName, version: 1, createdAt: '2026-10-29T00:00:00Z', members: [{ userId: leader.userId, displayName: leader.displayName, email: leader.email, role: 'leader' as const, joinedAt: '2026-10-29T00:00:00Z' }, { userId: sales.userId, displayName: sales.displayName, email: sales.email, role: 'member' as const, joinedAt: '2026-10-29T00:00:00Z' }], memberGroups: [] };
const childTeam = { ...team, teamId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: '上海一组', parentTeamId: operationsGroupId, parentTeamName: '华东运营组' };
const secondTeam = { ...team, teamId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', name: '华南销售组', members: [team.members[0], { userId: 'sales-2', displayName: 'Sales Two', email: 'sales-two@example.invalid', role: 'member' as const, joinedAt: '2026-10-29T01:00:00Z' }] };
const operationsGroup = { ...team, teamId: operationsGroupId, name: '华东运营组', unitType: 'operations' as const, parentTeamId: companyId, parentTeamName: organization.company.name, members: [team.members[0]] };
const invitation = { invitationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', teamId: team.teamId, teamName: team.name, inviterUserId: leader.userId, inviterName: leader.displayName, inviteeUserId: sales.userId, inviteeName: sales.displayName, status: 'pending' as const, version: 1, createdAt: '2026-10-29T00:00:00Z', decidedAt: null, canAccept: true, canDecline: true, canCancel: false };
const candidateId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const attentionItem = {
  itemId: '12121212-1212-4212-8212-121212121212', targetMemberUserId: sales.userId, targetMemberName: sales.displayName,
  sourceSupervisorUserId: leader.userId, sourceSupervisorName: leader.displayName,
  customerId: contact.customerId, customerName: contact.companyName, contactId: contact.contactId, contactName: 'Ana Lima', contactEmail: contact.email,
  mailEventId: null, analysisId: null, reason: 'important_reply', priority: 'urgent', status: 'open', note: '客户要求今天回复报价',
  result: null, version: 3, createdAt: '2026-10-30T01:00:00Z', updatedAt: '2026-10-30T01:20:00Z', acknowledgedAt: null, resolvedAt: null, dismissedAt: null,
  canAcknowledge: false, canDismiss: false, canResolve: true,
} satisfies TeamAttentionItem;

function attentionPage(scope: TeamAttentionPage['scope'], items: TeamAttentionItem[]): TeamAttentionPage {
  const counts = { open: 0, acknowledged: 0, resolved: 0, dismissed: 0 };
  for (const item of items) counts[item.status]++;
  return { scope, items, total: items.length, counts };
}

function context(value: Partial<TeamContext>): TeamContext {
  return { team: null, incomingInvitations: [], outgoingInvitations: [], canCreate: true, canAdmin: false, isSuperAdmin: false, adminTeams: [], ...value };
}

const monitoredTeam: TeamAdminSummary = { teamId: team.teamId, name: team.name, unitType: 'sales_team', organizationKind: 'sales_team', parentTeamId: operationsGroupId, parentTeamName: operationsGroup.name, assignmentSourceTeamIds: [operationsGroupId], assignedLeadCount: 3, depth: 1, childCount: 0, leaderName: leader.displayName, memberCount: 2, pendingInvitationCount: 0, createdAt: team.createdAt, version: 1 };

function monitoringOverview(scope: TeamMonitoringOverview['scope']): TeamMonitoringOverview {
  const counts = { contacts: 2, uncontacted: 0, contacted: 1, replied: 1, bounced: 0, autoreply: 0, openActions: 1, overdueActions: 0, importantReplies: 1, openAttention: 1, pendingAssignments: 0, pendingTransfers: 0 };
  const rates = { contactRate: 1, replyRate: 0.5, bounceRate: 0, actionRate: 0.5 };
  return {
    scope, generatedAt: '2026-10-30T02:00:00Z',
    units: { items: [{ unitId: team.teamId, name: team.name, kind: 'sales_team', parentUnitId: operationsGroupId, memberCount: 2, counts, rates }], total: 1 },
    members: { items: [{ userId: sales.userId, displayName: sales.displayName, email: sales.email, teamId: team.teamId, teamName: team.name, organizationKind: 'sales_team', counts, rates, stages: { cold: 0, reaching: 1, quoting: 1, trial: 0, cooperating: 0, lost: 0, other: 0 }, lastActivityAt: '2026-10-30T01:00:00Z', latestImportantReplyAt: null }], total: 1 },
    counts, rates, pool: scope === 'leader' ? null : { unassignedOperationsContacts: 4, assignedOperationsContacts: 8, pendingAssignmentRequests: 2, pendingTransferRequests: 1 }, importantReplies: [],
  };
}

function performanceOverview(scope: SalesPerformanceOverview['scope']): SalesPerformanceOverview {
  const sufficient = { sampleCount: 6, minimumSampleSize: 5, sufficient: true, medianSeconds: 5400, p90Seconds: 14400 };
  return {
    scope, generatedAt: '2026-10-30T02:00:00Z', window: { from: '2026-08-01T00:00:00Z', to: '2026-10-30T23:59:59Z' }, groupBy: 'lead', total: 1,
    items: [{ key: sales.userId, label: sales.displayName, memberUserId: sales.userId, memberName: sales.displayName, teamId: scope === 'self' ? null : team.teamId, teamName: scope === 'self' ? null : team.name, claimCount: 4, customerCount: 4, completedTaskCount: 3, validReplyCount: 2, wonOpportunityCount: 1, metrics: { claimToFirstAction: sufficient, claimToValidReply: sufficient, claimToWon: sufficient, repeatPurchase: { repeatPurchaseCount: 1, repeatPurchaseCustomers: 1, wonCustomers: 2, rate: { count: 1, total: 2, rate: 0.5, sampleCount: 2, minimumSampleSize: 5, sufficient: false } } } }],
  };
}

describe('team workspace renderer', () => {
  let root: Root;
  let host: HTMLDivElement;
  let queryClient: QueryClient;
  let invoke: ReturnType<typeof vi.fn>;

  const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); };
  const waitFor = async (selector: string) => {
    for (let attempt = 0; attempt < 25; attempt++) {
      const node = host.querySelector(selector);
      if (node) return node as HTMLElement;
      await flush();
    }
    throw new Error(`Missing selector: ${selector}\n${host.innerHTML}`);
  };
  const tabButton = (label: string) => Array.from(host.querySelectorAll<HTMLButtonElement>('.team-section-tabs button')).find(button => button.textContent === label) ?? null;
  const setInput = async (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
  };
  const setTextArea = async (input: HTMLTextAreaElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
  };
  const setSelect = async (select: HTMLSelectElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(select, value); select.dispatchEvent(new Event('change', { bubbles: true })); });
  };
  const render = async () => {
    await act(async () => root.render(<QueryClientProvider client={queryClient}><TeamWorkspace /></QueryClientProvider>));
    await flush();
  };

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.history.replaceState(null, '', '#/team');
    identityState.identity = sales as unknown as Record<string, unknown>;
    identityState.status = 'authenticated';
    invoke = vi.fn(async (channel: string, ...args: unknown[]): Promise<Result<unknown>> => {
      if (channel === ONLINE_CHANNELS.TEAM_CONTEXT) return { ok: true, data: context({ team, canCreate: false }) };
      if (channel === ONLINE_CHANNELS.TEAM_DETAIL) return { ok: true, data: { team, outgoingInvitations: [], children: [] } };
      if (channel === ONLINE_CHANNELS.TEAM_CANDIDATES) return { ok: true, data: { items: [{ userId: 'invitee-1', displayName: 'Invitee One', email: 'invitee@example.invalid' }], total: 1 } };
      if (channel === ONLINE_CHANNELS.CONTACT_LIST) return { ok: true, data: { items: [contact], total: 1 } };
      if (channel === ONLINE_CHANNELS.TASK_LIST) return { ok: true, data: { items: [task], total: 1 } };
      if (channel === ONLINE_CHANNELS.TEAM_ATTENTION_LIST) return { ok: true, data: attentionPage('member', []) };
      if (channel === ONLINE_CHANNELS.SALES_PERFORMANCE) return { ok: true, data: performanceOverview('self') };
      if (channel === ONLINE_CHANNELS.TEAM_INVITATION_ACCEPT) return { ok: true, data: context({ team, canCreate: false }) };
      return { ok: false, error: { code: 'NOT_FOUND', message: `未接入:${channel}` } };
    });
    Object.defineProperty(window, 'api', { configurable: true, value: { invoke } });
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    queryClient.clear();
    host.remove();
    document.body.innerHTML = '';
  });

  it('only exposes the workbench after a real team membership exists', async () => {
    await render();
    await waitFor('.personal-action-row');
    expect(host.querySelector('.personal-task-panel')).not.toBeNull();
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.TASK_LIST, expect.objectContaining({ status: 'open', mine: true }));
    const tabs = Array.from(host.querySelectorAll('.team-section-tabs button')).map(button => button.textContent);
    expect(tabs).toEqual(['个人', '我的团队', '团队管理']);
    expect(tabs).not.toContain('绩效');
    expect(tabs).not.toContain('监控');
    expect(invoke.mock.calls.some(call => call[0] === ONLINE_CHANNELS.TEAM_MONITORING)).toBe(false);
    expect(host.querySelector('.personal-metrics')?.textContent).toContain('我的线索');
    expect(host.querySelector('.personal-workspace-body')).not.toBeNull();
    expect(host.querySelector('.team-attention-panel')).toBeNull();
  });

  it('gives a super administrator the same personal workbench structure with mine-only tasks', async () => {
    identityState.identity = superAdmin as unknown as Record<string, unknown>;
    invoke.mockImplementation(async (channel: string): Promise<Result<unknown>> => {
      if (channel === ONLINE_CHANNELS.TEAM_CONTEXT) return { ok: true, data: context({ canCreate: true, canAdmin: true, isSuperAdmin: true, adminTeams: [], organization }) };
      if (channel === ONLINE_CHANNELS.CONTACT_LIST) return { ok: true, data: { items: [contact], total: 1 } };
      if (channel === ONLINE_CHANNELS.TASK_LIST) return { ok: true, data: { items: [task], total: 1 } };
      if (channel === ONLINE_CHANNELS.TEAM_ATTENTION_LIST) return { ok: true, data: attentionPage('member', []) };
      return { ok: false, error: { code: 'NOT_FOUND', message: `未接入:${channel}` } };
    });
    await render();
    await waitFor('.team-section-tabs');
    await act(async () => tabButton('个人')!.click());
    await waitFor('.personal-task-panel');
    await vi.waitFor(() => expect(host.querySelector('.personal-task-panel')?.textContent).toContain(task.title));

    expect(host.querySelector('.personal-workspace-body')?.classList.contains('has-tasks')).toBe(true);
    expect(host.querySelector('.personal-metrics')?.textContent).toContain('开放待办');
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.TASK_LIST, expect.objectContaining({ status: 'open', mine: true }));
  });

  it('keeps the personal task panel usable while the center is waiting for its mine-query update', async () => {
    identityState.identity = superAdmin as unknown as Record<string, unknown>;
    const ownTask = { ...task, taskId: 'task-admin', title: '处理本人任务', responsibleUserId: superAdmin.userId, responsibleName: superAdmin.displayName };
    invoke.mockImplementation(async (channel: string, input?: unknown): Promise<Result<unknown>> => {
      if (channel === ONLINE_CHANNELS.TEAM_CONTEXT) return { ok: true, data: context({ canCreate: true, canAdmin: true, isSuperAdmin: true, adminTeams: [], organization }) };
      if (channel === ONLINE_CHANNELS.CONTACT_LIST) return { ok: true, data: { items: [contact], total: 1 } };
      if (channel === ONLINE_CHANNELS.TASK_LIST && (input as { mine?: boolean } | undefined)?.mine) return { ok: false, error: { code: 'INVALID_INPUT', message: '任务列表参数无效' } };
      if (channel === ONLINE_CHANNELS.TASK_LIST) return { ok: true, data: { items: [task, ownTask], total: 2 } };
      if (channel === ONLINE_CHANNELS.TEAM_ATTENTION_LIST) return { ok: true, data: attentionPage('member', []) };
      return { ok: false, error: { code: 'NOT_FOUND', message: `未接入:${channel}` } };
    });
    await render();
    await waitFor('.team-section-tabs');
    await act(async () => tabButton('个人')!.click());
    await vi.waitFor(() => expect(host.querySelector('.personal-task-panel')?.textContent).toContain(ownTask.title));

    expect(host.querySelector('.personal-task-panel')?.textContent).not.toContain(task.title);
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.TASK_LIST, expect.objectContaining({ status: 'open', limit: 100, offset: 0 }));
  });

  it('lets an ordinary member open the team roster and collaboration without management controls', async () => {
    await render();
    await waitFor('.personal-action-row');
    await act(async () => tabButton('我的团队')!.click());
    const teamRow = await waitFor('.team-admin-tree-row') as HTMLButtonElement;
    await act(async () => teamRow.click());
    const memberRow = await waitFor('.team-admin-member-tree-row') as HTMLButtonElement;
    expect(host.querySelector('.team-admin-section-actions')).toBeNull();
    expect(host.textContent).toContain('Team Leader');
    await act(async () => memberRow.click());
    await waitFor('.team-member-collaboration-head');
    expect(host.querySelector('.team-member-collaboration-head')?.textContent).toContain('Team Leader');
    expect(host.querySelector('.team-collaboration-composer')).not.toBeNull();
  });

  it('does not expose the performance page to an ordinary sales account', async () => {
    await render();
    await waitFor('.personal-action-row');
    expect(Array.from(host.querySelectorAll('.team-section-tabs button')).map(button => button.textContent)).not.toContain('绩效');
    expect(host.querySelector('.team-performance-view')).toBeNull();
    expect(invoke.mock.calls.some(item => item[0] === ONLINE_CHANNELS.SALES_PERFORMANCE)).toBe(false);
    expect(invoke.mock.calls.some(item => item[0] === ONLINE_CHANNELS.TEAM_MONITORING)).toBe(false);
  });

  it('shows monitoring to a real leader and opens the managed-team overview', async () => {
    identityState.identity = leader as unknown as Record<string, unknown>;
    invoke.mockImplementation(async (channel: string): Promise<Result<unknown>> => {
      if (channel === ONLINE_CHANNELS.TEAM_CONTEXT) return { ok: true, data: context({ team, canCreate: false, managedTeams: [monitoredTeam] }) };
      if (channel === ONLINE_CHANNELS.TEAM_MONITORING) return { ok: true, data: monitoringOverview('leader') };
      if (channel === ONLINE_CHANNELS.CONTACT_LIST) return { ok: true, data: { items: [contact], total: 1 } };
      if (channel === ONLINE_CHANNELS.TASK_LIST) return { ok: true, data: { items: [task], total: 1 } };
      return { ok: false, error: { code: 'NOT_FOUND', message: `未接入:${channel}` } };
    });
    await render();
    await waitFor('.personal-action-row');
    expect(Array.from(host.querySelectorAll('.team-section-tabs button')).map(button => button.textContent)).not.toContain('绩效');
    const monitor = Array.from(host.querySelectorAll<HTMLButtonElement>('.team-section-tabs button')).find(button => button.textContent === '监控')!;
    expect(monitor).toBeTruthy();
    await act(async () => monitor.click());
    await waitFor('.team-monitoring-view');
    expect(host.querySelector('.team-monitoring-heading')?.textContent).toContain('负责团队');
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.TEAM_MONITORING, expect.objectContaining({ limit: 10, offset: 0, unitLimit: 20 }));
  });

  it('shows the performance page to an operations administrator', async () => {
    identityState.identity = operations as unknown as Record<string, unknown>;
    invoke.mockImplementation(async (channel: string): Promise<Result<unknown>> => {
      if (channel === ONLINE_CHANNELS.TEAM_CONTEXT) return { ok: true, data: context({ canAdmin: true, adminTeams: [monitoredTeam], organization }) };
      if (channel === ONLINE_CHANNELS.SALES_PERFORMANCE) return { ok: true, data: performanceOverview('operations') };
      return { ok: false, error: { code: 'NOT_FOUND', message: `未接入:${channel}` } };
    });
    await render();
    await waitFor('.team-section-tabs');
    const performanceTab = Array.from(host.querySelectorAll<HTMLButtonElement>('.team-section-tabs button')).find(button => button.textContent === '绩效')!;
    expect(performanceTab).toBeTruthy();
    await act(async () => performanceTab.click());
    await waitFor('.team-performance-view');
    expect(host.querySelector('.team-performance-view')?.textContent).toContain('运营范围绩效');
    expect(host.querySelector('.team-workspace-header')).toBeNull();
  });

  it.each([
    ['operations', operations, '运营共享'],
    ['superadmin', superAdmin, '全局'],
  ] as const)('shows the in-scope monitoring range to %s accounts', async (_name, account, label) => {
    identityState.identity = account as unknown as Record<string, unknown>;
    invoke.mockImplementation(async (channel: string, input?: unknown): Promise<Result<unknown>> => {
      if (channel === ONLINE_CHANNELS.TEAM_CONTEXT) return { ok: true, data: context({ canAdmin: true, isSuperAdmin: account.identityAdmin, adminTeams: [monitoredTeam], organization, managedTeams: account.identityAdmin ? [monitoredTeam] : undefined }) };
      if (channel === ONLINE_CHANNELS.TEAM_MONITORING) return { ok: true, data: monitoringOverview(account.identityAdmin ? 'superadmin' : 'operations') };
      return { ok: false, error: { code: 'NOT_FOUND', message: input ? `未接入:${channel}` : channel } };
    });
    await render();
    await waitFor('.team-section-tabs');
    const monitor = Array.from(host.querySelectorAll<HTMLButtonElement>('.team-section-tabs button')).find(button => button.textContent === '监控')!;
    expect(monitor).toBeTruthy();
    await act(async () => monitor.click());
    await waitFor('.team-monitoring-view');
    expect(host.querySelector('.team-monitoring-heading')?.textContent).toContain(label);
  });

  it('refreshes team context when the window regains focus', async () => {
    await render();
    await waitFor('.personal-action-row');
    const initial = invoke.mock.calls.filter(call => call[0] === ONLINE_CHANNELS.TEAM_CONTEXT).length;
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await vi.waitFor(() => expect(invoke.mock.calls.filter(call => call[0] === ONLINE_CHANNELS.TEAM_CONTEXT).length).toBeGreaterThan(initial));
  });

  it('shows creation and invitation handling when the account has no team', async () => {
    identityState.identity = leader as unknown as Record<string, unknown>;
    invoke.mockImplementation(async (channel: string): Promise<Result<unknown>> => {
      if (channel === ONLINE_CHANNELS.TEAM_CONTEXT) return { ok: true, data: context({ incomingInvitations: [invitation] }) };
      if (channel === ONLINE_CHANNELS.TEAM_CANDIDATES) return { ok: true, data: { items: [{ userId: 'invitee-1', displayName: 'Invitee One', email: 'invitee@example.invalid' }], total: 1 } };
      if (channel === ONLINE_CHANNELS.TEAM_INVITATION_ACCEPT) return { ok: true, data: context({ team, canCreate: false }) };
      return { ok: false, error: { code: 'NOT_FOUND', message: `未接入:${channel}` } };
    });
    await render();
    await waitFor('.team-setup-view');
    expect(host.querySelector('.team-setup-view')?.textContent).toContain('创建团队');
    expect(host.querySelector('.team-setup-view')?.textContent).toContain('成员邀请');
    const accept = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === '接受')!;
    await act(async () => accept.click());
    await flush();
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.TEAM_INVITATION_ACCEPT, invitation.invitationId, expect.objectContaining({ expectedVersion: 1, idempotencyKey: expect.any(String) }));
  });

  it('creates a team with selected center accounts using the new create channel', async () => {
    identityState.identity = leader as unknown as Record<string, unknown>;
    invoke.mockImplementation(async (channel: string): Promise<Result<unknown>> => {
      if (channel === ONLINE_CHANNELS.TEAM_CONTEXT) return { ok: true, data: context({}) };
      if (channel === ONLINE_CHANNELS.TEAM_CANDIDATES) return { ok: true, data: { items: [{ userId: candidateId, displayName: 'Invitee One', email: 'invitee@example.invalid' }], total: 1 } };
      if (channel === ONLINE_CHANNELS.TEAM_CREATE) return { ok: true, data: { teamId: team.teamId, context: context({ team, canCreate: false }) } };
      return { ok: false, error: { code: 'NOT_FOUND', message: `未接入:${channel}` } };
    });
    await render();
    await waitFor('.team-setup-view');
    expect(host.querySelector('.team-create-type')).toBeNull();
    expect(host.querySelector('.team-leader-picker')).toBeNull();
    const input = await waitFor('.team-create-form input') as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setValue.call(input, '新团队'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    const memberSearch = host.querySelector<HTMLInputElement>('.team-candidate-picker .team-field-search input')!;
    await setInput(memberSearch, 'invitee');
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.TEAM_CANDIDATES, expect.objectContaining({ role: 'member', unitType: 'sales_team', purpose: 'create' }));
    const checkbox = await waitFor('.team-candidate-row input') as HTMLInputElement;
    await act(async () => checkbox.click());
    const create = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === '创建团队')!;
    await act(async () => create.click());
    await flush();
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.TEAM_CREATE, expect.objectContaining({ name: '新团队', parentTeamId: null, unitType: 'sales_team', inviteeUserIds: [candidateId], idempotencyKey: expect.any(String) }));
  });

  it('locks the creator as the operations-group leader', async () => {
    identityState.identity = operations as unknown as Record<string, unknown>;
    const groupSummary = { teamId: operationsGroupId, name: operationsGroup.name, unitType: 'operations' as const, organizationKind: 'operations_group' as const, parentTeamId: companyId, parentTeamName: organization.company.name, depth: 0, childCount: 0, leaderName: leader.displayName, memberCount: 1, pendingInvitationCount: 0, createdAt: team.createdAt };
    invoke.mockImplementation(async (channel: string, input?: unknown): Promise<Result<unknown>> => {
      if (channel === ONLINE_CHANNELS.TEAM_CONTEXT) return { ok: true, data: context({ canAdmin: true, adminTeams: [groupSummary], organization }) };
      if (channel === ONLINE_CHANNELS.TEAM_CREATE) return { ok: true, data: { teamId: operationsGroupId, context: context({ canAdmin: true, adminTeams: [groupSummary], organization }) } };
      return { ok: false, error: { code: 'NOT_FOUND', message: `未接入:${channel}` } };
    });
    await render();
    await waitFor('.team-section-tabs');
    const management = tabButton('我的团队')!;
    await act(async () => management.click());
    await waitFor('.team-admin-view > .team-admin-toolbar');
    expect(host.querySelector('.team-workspace-header')).toBeNull();
    expect(host.querySelector('.team-workspace-primary-action')?.textContent).toContain('新建团队');
    expect(host.querySelector('.team-admin-directory-root')).not.toBeNull();
    const create = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === '新建团队')!;
    await act(async () => create.click());
    await waitFor('.team-create-form');
    expect(host.querySelector('.team-create-type')).toBeNull();
    await setInput(host.querySelector<HTMLInputElement>('.team-create-form input[placeholder="运营组名称"]')!, '华北运营组');
    expect(Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === '创建团队')?.disabled).toBe(false);
    const lockedLeader = await waitFor('.team-leader-picker .team-candidate-row.is-locked') as HTMLElement;
    expect(lockedLeader.textContent).toContain('Operations One');
    expect(lockedLeader.textContent).toContain('创建者');
    expect(lockedLeader.querySelector('input')?.disabled).toBe(true);
    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === '创建团队')!.click());
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.TEAM_CREATE, expect.objectContaining({ name: '华北运营组', unitType: 'operations', parentTeamId: null, leaderUserId: operations.userId, inviteeUserIds: [] }));
  });

  it('renders expired invitations as expired and does not expose accept or decline actions', async () => {
    identityState.identity = leader as unknown as Record<string, unknown>;
    const expired = { ...invitation, invitationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', status: 'expired' as const, canAccept: false, canDecline: false };
    invoke.mockImplementation(async (channel: string): Promise<Result<unknown>> => {
      if (channel === ONLINE_CHANNELS.TEAM_CONTEXT) return { ok: true, data: context({ incomingInvitations: [expired] }) };
      if (channel === ONLINE_CHANNELS.TEAM_CANDIDATES) return { ok: true, data: { items: [], total: 0 } };
      return { ok: false, error: { code: 'NOT_FOUND', message: `未接入:${channel}` } };
    });
    await render();
    await waitFor('.team-invitation-row.is-expired');
    expect(host.querySelector('.team-invitation-row.is-expired')?.textContent).toContain('已过期');
    expect(Array.from(host.querySelectorAll('.team-invitation-row.is-expired button')).map(button => button.textContent)).not.toContain('接受');
    expect(Array.from(host.querySelectorAll('.team-invitation-row.is-expired button')).map(button => button.textContent)).not.toContain('拒绝');
  });

  it('labels expired outgoing invitations and removes the cancel action in team details', async () => {
    identityState.identity = leader as unknown as Record<string, unknown>;
    const expired = { ...invitation, invitationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', status: 'expired' as const, canAccept: false, canDecline: false, canCancel: false };
    invoke.mockImplementation(async (channel: string): Promise<Result<unknown>> => {
      if (channel === ONLINE_CHANNELS.TEAM_CONTEXT) return { ok: true, data: context({ team, canCreate: false, outgoingInvitations: [expired] }) };
      if (channel === ONLINE_CHANNELS.CONTACT_LIST) return { ok: true, data: { items: [contact], total: 1 } };
      if (channel === ONLINE_CHANNELS.TASK_LIST) return { ok: true, data: { items: [task], total: 1 } };
      return { ok: false, error: { code: 'NOT_FOUND', message: `未接入:${channel}` } };
    });
    await render();
    await waitFor('.team-section-tabs');
    const teamTab = tabButton('团队管理')!;
    await act(async () => teamTab.click());
    await waitFor('.team-pending-row.is-expired');
    expect(host.querySelector('.team-pending-row.is-expired')?.textContent).toContain('已过期');
    expect(host.querySelector('.team-pending-row.is-expired button')).toBeNull();
  });

  it('lets the leader open team composition and invite more members', async () => {
    identityState.identity = leader as unknown as Record<string, unknown>;
    invoke.mockImplementation(async (channel: string): Promise<Result<unknown>> => {
      if (channel === ONLINE_CHANNELS.TEAM_CONTEXT) return { ok: true, data: context({ team, canCreate: false }) };
      if (channel === ONLINE_CHANNELS.CONTACT_LIST) return { ok: true, data: { items: [contact], total: 1 } };
      if (channel === ONLINE_CHANNELS.TASK_LIST) return { ok: true, data: { items: [task], total: 1 } };
      if (channel === ONLINE_CHANNELS.TEAM_CANDIDATES) return { ok: true, data: { items: [{ userId: 'invitee-1', displayName: 'Invitee One', email: 'invitee@example.invalid' }], total: 1 } };
      return { ok: false, error: { code: 'NOT_FOUND', message: `未接入:${channel}` } };
    });
    await render();
    await waitFor('.team-section-tabs');
    const teamTab = tabButton('团队管理')!;
    await act(async () => teamTab.click());
    await waitFor('.team-info-view');
    expect(host.querySelector('.team-info-view')?.textContent).toContain('华东销售组');
    expect(host.querySelector('.team-info-view')?.textContent).toContain('邀请成员');
    expect(host.querySelector('.team-info-view')?.textContent).toContain('Team Leader');
    const invite = Array.from(host.querySelectorAll<HTMLButtonElement>('.team-info-view button')).find(button => button.textContent === '邀请成员')!;
    await act(async () => invite.click());
    const memberSearch = await waitFor('.team-invite-panel .team-field-search input') as HTMLInputElement;
    await setInput(memberSearch, 'invitee');
    await waitFor('.team-invite-panel .team-candidate-row');
    const candidatesCall = invoke.mock.calls.find(call => call[0] === ONLINE_CHANNELS.TEAM_CANDIDATES);
    expect(candidatesCall?.[1]).not.toHaveProperty('purpose');
  });

  it('lets a multi-team leader switch teams and shows that leader consistently in each roster', async () => {
    identityState.identity = leader as unknown as Record<string, unknown>;
    const summaries = [team, secondTeam].map((item, depth) => ({ teamId: item.teamId, name: item.name, parentTeamId: null, parentTeamName: null, depth, childCount: 0, leaderName: item.leaderName, memberCount: item.members.length, pendingInvitationCount: 0, createdAt: item.createdAt }));
    invoke.mockImplementation(async (channel: string, teamId?: unknown): Promise<Result<unknown>> => {
      if (channel === ONLINE_CHANNELS.TEAM_CONTEXT) return { ok: true, data: context({ team, canCreate: false, managedTeams: summaries }) };
      if (channel === ONLINE_CHANNELS.TEAM_DETAIL && teamId === secondTeam.teamId) return { ok: true, data: { team: secondTeam, outgoingInvitations: [], children: [] } };
      if (channel === ONLINE_CHANNELS.CONTACT_LIST) return { ok: true, data: { items: [contact], total: 1 } };
      if (channel === ONLINE_CHANNELS.TASK_LIST) return { ok: true, data: { items: [task], total: 1 } };
      return { ok: false, error: { code: 'NOT_FOUND', message: `未接入:${channel}` } };
    });
    await render();
    await waitFor('.team-section-tabs');
    const teamTab = tabButton('团队管理')!;
    await act(async () => teamTab.click());
    const switcher = await waitFor('.team-managed-switcher select') as HTMLSelectElement;
    expect(Array.from(host.querySelectorAll('.team-section-tabs button')).map(button => button.textContent)).toContain('我的团队');
    expect(Array.from(host.querySelectorAll('.team-section-tabs button')).map(button => button.textContent)).toContain('团队管理');
    const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    await act(async () => { setValue.call(switcher, secondTeam.teamId); switcher.dispatchEvent(new Event('change', { bubbles: true })); });
    for (let attempt = 0; attempt < 25 && host.querySelector('.team-info-head h2')?.textContent !== '华南销售组'; attempt++) await flush();
    expect(host.querySelector('.team-info-head h2')?.textContent).toBe('华南销售组');
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.TEAM_DETAIL, secondTeam.teamId);
    expect(host.querySelectorAll('.team-member-row')).toHaveLength(2);
    expect(host.querySelector('.team-member-list')?.textContent).toContain('Team Leader');
    expect(host.querySelector('.team-members-panel')?.textContent).toContain('Sales Two');
  });

  it('shows the server-derived member count and renders display groups without widening privacy', async () => {
    identityState.identity = leader as unknown as Record<string, unknown>;
    const groupedTeam = {
      ...team,
      memberCount: 12,
      memberGroups: [{ groupId: 'group-1', teamId: team.teamId, name: '重点客户', memberIds: [sales.userId], version: 3 }],
    };
    invoke.mockImplementation(async (channel: string): Promise<Result<unknown>> => {
      if (channel === ONLINE_CHANNELS.TEAM_CONTEXT) return { ok: true, data: context({ team: groupedTeam, canCreate: false }) };
      if (channel === ONLINE_CHANNELS.CONTACT_LIST) return { ok: true, data: { items: [contact], total: 1 } };
      if (channel === ONLINE_CHANNELS.TASK_LIST) return { ok: true, data: { items: [task], total: 1 } };
      return { ok: false, error: { code: 'NOT_FOUND', message: `未接入:${channel}` } };
    });
    await render();
    await waitFor('.team-section-tabs');
    const teamTab = tabButton('团队管理')!;
    await act(async () => teamTab.click());
    await waitFor('.team-member-group');
    expect(host.querySelector('.team-info-head')?.textContent).toContain('12 人');
    expect(host.querySelector('.team-member-group summary')?.textContent).toContain('重点客户');
    expect(host.querySelector('.team-member-group')?.textContent).toContain('Sales One');
  });

  it('reuses the idempotency key when an invitation cancellation result is unknown', async () => {
    identityState.identity = leader as unknown as Record<string, unknown>;
    const cancellable = { ...invitation, inviterUserId: leader.userId, inviterName: leader.displayName, canCancel: true };
    let attempts = 0;
    invoke.mockImplementation(async (channel: string): Promise<Result<unknown>> => {
      if (channel === ONLINE_CHANNELS.TEAM_CONTEXT) return { ok: true, data: context({ team, canCreate: false, outgoingInvitations: [cancellable] }) };
      if (channel === ONLINE_CHANNELS.CONTACT_LIST) return { ok: true, data: { items: [contact], total: 1 } };
      if (channel === ONLINE_CHANNELS.TASK_LIST) return { ok: true, data: { items: [task], total: 1 } };
      if (channel === ONLINE_CHANNELS.TEAM_INVITATION_CANCEL) {
        attempts++;
        return attempts === 1
          ? { ok: false, error: { code: 'UNAVAILABLE', message: '中心服务暂不可用' } }
          : { ok: true, data: context({ team, canCreate: false }) };
      }
      return { ok: false, error: { code: 'NOT_FOUND', message: `未接入:${channel}` } };
    });
    await render();
    await waitFor('.team-section-tabs');
    const teamTab = tabButton('团队管理')!;
    await act(async () => teamTab.click());
    const cancel = await waitFor('.team-pending-row button') as HTMLButtonElement;
    await act(async () => cancel.click());
    await flush();
    await act(async () => cancel.click());
    await flush();
    const keys = invoke.mock.calls.filter(call => call[0] === ONLINE_CHANNELS.TEAM_INVITATION_CANCEL).map(call => (call[2] as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('gives management roles a read-only team overview without creating a customer duplicate', async () => {
    identityState.identity = operations as unknown as Record<string, unknown>;
    invoke.mockImplementation(async (channel: string): Promise<Result<unknown>> => {
      if (channel === ONLINE_CHANNELS.TEAM_CONTEXT) return { ok: true, data: context({ team, canCreate: false, canAdmin: true, adminTeams: [{ teamId: team.teamId, name: team.name, parentTeamId: null, parentTeamName: null, depth: 0, childCount: 0, leaderName: team.leaderName, memberCount: 2, pendingInvitationCount: 0, createdAt: team.createdAt }] }) };
      if (channel === ONLINE_CHANNELS.CONTACT_LIST) return { ok: true, data: { items: [contact], total: 1 } };
      return { ok: false, error: { code: 'NOT_FOUND', message: `未接入:${channel}` } };
    });
    await render();
    await waitFor('.team-section-tabs');
    const overview = tabButton('我的团队')!;
    await act(async () => overview.click());
    await waitFor('.team-admin-view');
    expect(host.querySelector('.team-admin-view')?.textContent).toContain('华东销售组');
    expect(host.querySelector('.personal-action-row')).toBeNull();
  });

  it('keeps team management in the list tab and exposes detail/create/back navigation', async () => {
    identityState.identity = superAdmin as unknown as Record<string, unknown>;
    const groupSummary = { teamId: operationsGroupId, name: operationsGroup.name, unitType: 'operations' as const, organizationKind: 'operations_group' as const, parentTeamId: companyId, parentTeamName: organization.company.name, depth: 0, childCount: 1, leaderName: team.leaderName, memberCount: 1, pendingInvitationCount: 0, createdAt: team.createdAt };
    const teamSummary = { teamId: team.teamId, name: team.name, unitType: 'sales_team' as const, organizationKind: 'sales_team' as const, parentTeamId: operationsGroupId, parentTeamName: operationsGroup.name, assignmentSourceTeamIds: [operationsGroupId], assignedLeadCount: 3, depth: 1, childCount: 0, leaderName: team.leaderName, memberCount: 2, pendingInvitationCount: 0, createdAt: team.createdAt };
    invoke.mockImplementation(async (channel: string, input?: unknown): Promise<Result<unknown>> => {
      if (channel === ONLINE_CHANNELS.TEAM_CONTEXT) return { ok: true, data: context({ canCreate: true, canAdmin: true, isSuperAdmin: true, adminTeams: [groupSummary, teamSummary], organization }) };
      if (channel === ONLINE_CHANNELS.TEAM_DETAIL) return { ok: true, data: { team: input === team.teamId ? team : operationsGroup, outgoingInvitations: [], children: input === team.teamId ? [] : [teamSummary] } };
      if (channel === ONLINE_CHANNELS.TEAM_CANDIDATES) return { ok: true, data: { items: [], total: 0 } };
      return { ok: false, error: { code: 'NOT_FOUND', message: `未接入:${channel}` } };
    });
    await render();
    await waitFor('.team-admin-workspace.is-directory');
    expect(host.querySelector('.team-admin-rail-heading')?.textContent).toContain('我的团队');
    expect(host.querySelector('.team-admin-directory-foot')).toBeNull();
    const contextSearch = await waitFor('.team-workspace-search input') as HTMLInputElement;
    await setInput(contextSearch, '没有这个团队');
    expect(host.querySelectorAll('.team-admin-directory-root')).toHaveLength(0);
    expect(host.querySelector('.team-admin-tree')?.textContent).toContain('没有匹配的团队');
    await setInput(contextSearch, '');
    const groupRow = host.querySelector<HTMLButtonElement>('.team-admin-directory-main')!;
    expect(groupRow.textContent).toContain('华东运营组');
    expect(host.querySelectorAll('.team-admin-tree-row[data-depth="1"]')).toHaveLength(1);
    expect(host.querySelector('.team-admin-org-node')).toBeNull();
    expect(host.querySelector('.team-admin-stat-grid')?.textContent).toContain('销售团队');
    await act(async () => groupRow.click());
    await waitFor('.team-admin-team-head');
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.TEAM_DETAIL, operationsGroupId);
    expect(host.querySelector('.team-admin-member-list')).toBeNull();
    expect(host.querySelector('.team-admin-tree.compact')).toBeNull();
    expect(Array.from(host.querySelectorAll<HTMLButtonElement>('button')).some(button => button.textContent === '新建销售团队')).toBe(false);
    const back = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === '返回团队树')!;
    await act(async () => back.click());
    await waitFor('.team-admin-workspace.is-directory');
    const canvasTab = Array.from(host.querySelectorAll<HTMLButtonElement>('.team-admin-view-tabs button')).find(button => button.textContent === '团队画布')!;
    await act(async () => canvasTab.click());
    const viewport = await waitFor('.team-admin-canvas-viewport');
    expect(host.querySelectorAll('.team-admin-org-node')).toHaveLength(2);
    expect(host.querySelector('.team-admin-org-node.is-superadmin')).toBeNull();
    expect(host.querySelector('.team-admin-org-node.is-company')).toBeNull();
    expect(Array.from(host.querySelectorAll('.team-admin-org-leader')).some(node => node.textContent?.includes('群主'))).toBe(true);
    const salesNode = Array.from(host.querySelectorAll<HTMLElement>('.team-admin-org-node')).find(node => node.textContent?.includes('华东销售组'))!;
    await act(async () => salesNode.querySelector<HTMLButtonElement>('.team-admin-org-node-main')!.click());
    await vi.waitFor(() => expect(host.querySelector('.team-admin-org-member-row')).not.toBeNull(), { timeout: 2_000 });
    const memberRow = host.querySelector('.team-admin-org-member-row')!;
    expect(memberRow.tagName).toBe('DIV');
    expect(invoke.mock.calls.some(([channel]) => channel === ONLINE_CHANNELS.TEAM_MONITORING_MEMBER)).toBe(false);
    Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 800 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 600 });
    const zoomLabel = host.querySelector('.team-admin-canvas-actions span')?.textContent;
    await act(async () => viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -120, clientX: 300, clientY: 220 })));
    expect(host.querySelector('.team-admin-canvas-actions span')?.textContent).not.toBe(zoomLabel);
    expect(host.querySelector<HTMLElement>('.team-admin-canvas-stage')?.style.transform).toContain('translate3d');
  });

  it('keeps the canvas mode when a background team context refresh fails transiently', async () => {
    identityState.identity = superAdmin as unknown as Record<string, unknown>;
    const groupSummary = { teamId: operationsGroupId, name: operationsGroup.name, unitType: 'operations' as const, organizationKind: 'operations_group' as const, parentTeamId: companyId, parentTeamName: organization.company.name, depth: 0, childCount: 1, leaderName: team.leaderName, memberCount: 1, pendingInvitationCount: 0, createdAt: team.createdAt };
    const teamSummary = { teamId: team.teamId, name: team.name, unitType: 'sales_team' as const, organizationKind: 'sales_team' as const, parentTeamId: operationsGroupId, parentTeamName: operationsGroup.name, assignmentSourceTeamIds: [operationsGroupId], assignedLeadCount: 3, depth: 1, childCount: 0, leaderName: team.leaderName, memberCount: 2, pendingInvitationCount: 0, createdAt: team.createdAt };
    let failNextContext = false;
    invoke.mockImplementation(async (channel: string, input?: unknown): Promise<Result<unknown>> => {
      if (channel === ONLINE_CHANNELS.TEAM_CONTEXT) {
        if (failNextContext) {
          failNextContext = false;
          return { ok: false, error: { code: 'UNAVAILABLE', message: '中心服务暂不可用' } };
        }
        return { ok: true, data: context({ canCreate: true, canAdmin: true, isSuperAdmin: true, adminTeams: [groupSummary, teamSummary], organization }) };
      }
      if (channel === ONLINE_CHANNELS.TEAM_DETAIL) return { ok: true, data: { team: input === team.teamId ? team : operationsGroup, outgoingInvitations: [], children: [] } };
      return { ok: false, error: { code: 'NOT_FOUND', message: `未接入:${channel}` } };
    });
    await render();
    await waitFor('.team-section-tabs');
    const canvasTab = await waitFor('.team-admin-view-tabs button:nth-child(2)') as HTMLButtonElement;
    await act(async () => canvasTab.click());
    await waitFor('.team-admin-canvas-viewport');
    const contextCalls = invoke.mock.calls.filter(([channel]) => channel === ONLINE_CHANNELS.TEAM_CONTEXT).length;
    failNextContext = true;
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await new Promise(resolve => setTimeout(resolve, 30)); });
    await vi.waitFor(() => expect(invoke.mock.calls.filter(([channel]) => channel === ONLINE_CHANNELS.TEAM_CONTEXT).length).toBeGreaterThan(contextCalls));
    expect(host.querySelector('.team-admin-canvas-viewport')).not.toBeNull();
    expect(host.querySelector('.team-admin-workspace.is-directory')).toBeNull();
    expect(host.querySelector('.team-page-state.is-error')).toBeNull();
    expect(host.querySelector('.team-admin-view-tabs button[aria-current="page"]')?.textContent).toContain('团队画布');
  });

  it('renders the selected member as a collaboration workspace without exposing unsupported writes', async () => {
    identityState.identity = superAdmin as unknown as Record<string, unknown>;
    const groupSummary = { teamId: operationsGroupId, name: operationsGroup.name, unitType: 'operations' as const, organizationKind: 'operations_group' as const, parentTeamId: companyId, parentTeamName: organization.company.name, depth: 0, childCount: 1, leaderName: team.leaderName, memberCount: 1, pendingInvitationCount: 0, createdAt: team.createdAt };
    const teamSummary = { teamId: team.teamId, name: team.name, unitType: 'sales_team' as const, organizationKind: 'sales_team' as const, parentTeamId: operationsGroupId, parentTeamName: operationsGroup.name, assignmentSourceTeamIds: [operationsGroupId], assignedLeadCount: 3, depth: 1, childCount: 0, leaderName: team.leaderName, memberCount: 2, pendingInvitationCount: 0, createdAt: team.createdAt };
    invoke.mockImplementation(async (channel: string, input?: unknown): Promise<Result<unknown>> => {
      if (channel === ONLINE_CHANNELS.TEAM_CONTEXT) return { ok: true, data: context({ canCreate: true, canAdmin: true, isSuperAdmin: true, adminTeams: [groupSummary, teamSummary], organization }) };
      if (channel === ONLINE_CHANNELS.TEAM_DETAIL) return { ok: true, data: { team: input === team.teamId ? team : operationsGroup, outgoingInvitations: [], children: input === operationsGroupId ? [teamSummary] : [] } };
      return { ok: false, error: { code: 'NOT_FOUND', message: `未接入:${channel}` } };
    });
    await render();
    await waitFor('.team-section-tabs');
    await act(async () => tabButton('我的团队')!.click());
    const salesRow = await waitFor('.team-admin-tree-row[data-depth="1"]') as HTMLButtonElement;
    await act(async () => salesRow.click());
    await waitFor('.team-admin-member-tree-row');
    const memberButton = Array.from(host.querySelectorAll<HTMLButtonElement>('.team-admin-member-tree-row')).find(button => button.textContent?.includes('Sales One'))!;
    await act(async () => memberButton.click());
    await waitFor('.team-collaboration-log');
    expect(host.querySelector('.team-member-collaboration-head')?.textContent).toContain('Sales One');
    expect(host.querySelector('.team-admin-overview-aside > .team-admin-activity-drawer.is-overview')).not.toBeNull();
    expect(host.querySelector('.team-admin-rail .team-admin-activity-drawer')).toBeNull();
    expect(host.querySelector('.team-admin-member-main > .team-admin-activity-drawer')).toBeNull();
    expect(host.querySelector('.team-collaboration-log')?.textContent).toContain('暂无协作动态');
    expect(invoke.mock.calls.some(([channel]) => channel === ONLINE_CHANNELS.TEAM_MONITORING_MEMBER)).toBe(false);
    const overview = host.querySelector('.team-admin-overview-aside')?.textContent ?? '';
    expect(overview).not.toMatch(/触达率|回复率|最近活动|开放动作|关注项/);
    expect(Array.from(host.querySelectorAll<HTMLButtonElement>('.team-collaboration-tools button')).every(button => button.disabled)).toBe(true);
    expect(host.querySelector<HTMLTextAreaElement>('.team-collaboration-composer textarea')?.disabled).toBe(true);
    expect(host.querySelector('.team-collaboration-composer-box > button:disabled')?.textContent).toContain('发送');
  });

  it('runs member and display-group mutations from the compact inspector', async () => {
    identityState.identity = superAdmin as unknown as Record<string, unknown>;
    const groupSummary = { teamId: operationsGroupId, name: operationsGroup.name, unitType: 'operations' as const, organizationKind: 'operations_group' as const, parentTeamId: companyId, parentTeamName: organization.company.name, depth: 0, childCount: 1, leaderName: team.leaderName, memberCount: 1, pendingInvitationCount: 0, createdAt: team.createdAt };
    const teamSummary = { teamId: team.teamId, name: team.name, unitType: 'sales_team' as const, organizationKind: 'sales_team' as const, parentTeamId: operationsGroupId, parentTeamName: operationsGroup.name, assignmentSourceTeamIds: [operationsGroupId], assignedLeadCount: 3, depth: 1, childCount: 0, leaderName: team.leaderName, memberCount: 2, pendingInvitationCount: 0, createdAt: team.createdAt };
    const group = { groupId: '33333333-3333-4333-8333-333333333333', teamId: team.teamId, name: '重点客户', version: 1, memberIds: [sales.userId] };
    const detailedTeam = { ...team, memberGroups: [group] };
    const memberCandidateId = '55555555-5555-4555-8555-555555555555';
    invoke.mockImplementation(async (channel: string, input?: unknown): Promise<Result<unknown>> => {
      if (channel === ONLINE_CHANNELS.TEAM_CONTEXT) return { ok: true, data: context({ canCreate: true, canAdmin: true, isSuperAdmin: true, adminTeams: [groupSummary, teamSummary], organization }) };
      if (channel === ONLINE_CHANNELS.TEAM_DETAIL) return { ok: true, data: { team: detailedTeam, outgoingInvitations: [], children: [] } };
      if (channel === ONLINE_CHANNELS.TEAM_CANDIDATES) {
        return { ok: true, data: { items: [{ userId: memberCandidateId, displayName: 'New Member', email: 'new-member@example.invalid' }], total: 1 } };
      }
      if ([ONLINE_CHANNELS.TEAM_MEMBER, ONLINE_CHANNELS.TEAM_GROUP_SAVE, ONLINE_CHANNELS.TEAM_GROUP_DELETE].includes(channel)) return { ok: true, data: context({ canAdmin: true, adminTeams: [groupSummary, teamSummary], organization }) };
      return { ok: false, error: { code: 'NOT_FOUND', message: `未接入:${channel}` } };
    });
    await render();
    await waitFor('.team-section-tabs');
    const management = tabButton('我的团队')!;
    await act(async () => management.click());
    const salesRow = await waitFor('.team-admin-tree-row[data-depth="1"]') as HTMLButtonElement;
    await act(async () => salesRow.click());
    await waitFor('.team-admin-section-actions');
    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>('.team-admin-section-actions button')).find(button => button.textContent === '管理')!.click());
    await waitFor('button[aria-label="移出 Sales One"]');
    expect(host.querySelector('.team-admin-controls')).toBeNull();

    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="移出 Sales One"]')!.click());
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.TEAM_MEMBER, team.teamId, expect.objectContaining({ userId: sales.userId, action: 'remove', expectedVersion: 1, idempotencyKey: expect.any(String) }));

    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>('.team-inline-action')).find(button => button.textContent === '邀请')!.click());
    const memberSearch = host.querySelector<HTMLInputElement>('.team-admin-member-add .team-field-search input')!;
    await setInput(memberSearch, 'new');
    const memberOption = await waitFor('.team-admin-member-add .team-candidate-row input') as HTMLInputElement;
    await act(async () => memberOption.click());
    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === '发送邀请')!.click());
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.TEAM_INVITE, team.teamId, expect.objectContaining({ userIds: [memberCandidateId], idempotencyKey: expect.any(String) }));

    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>('.team-inline-action')).find(button => button.textContent === '分组')!.click());
    await setInput(host.querySelector<HTMLInputElement>('.team-group-editor > input')!, '新分组');
    const groupMember = host.querySelector<HTMLInputElement>('.team-group-members input')!;
    await act(async () => groupMember.click());
    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>('.team-group-editor button')).find(button => button.textContent === '保存')!.click());
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.TEAM_GROUP_SAVE, team.teamId, expect.objectContaining({ groupId: null, name: '新分组', expectedVersion: 0, idempotencyKey: expect.any(String) }));

    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="删除 重点客户"]')!.click());
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.TEAM_GROUP_DELETE, team.teamId, group.groupId, expect.objectContaining({ groupId: group.groupId, expectedVersion: 1, idempotencyKey: expect.any(String) }));
  });

  it('confirms team dissolution for the primary leader and returns to the team context', async () => {
    identityState.identity = leader as unknown as Record<string, unknown>;
    const dissolvableTeam = { ...team, canDissolve: true };
    let dissolved = false;
    invoke.mockImplementation(async (channel: string): Promise<Result<unknown>> => {
      if (channel === ONLINE_CHANNELS.TEAM_CONTEXT) return { ok: true, data: context({ team: dissolved ? null : dissolvableTeam, canCreate: true }) };
      if (channel === ONLINE_CHANNELS.CONTACT_LIST) return { ok: true, data: { items: [contact], total: 1 } };
      if (channel === ONLINE_CHANNELS.TASK_LIST) return { ok: true, data: { items: [task], total: 1 } };
      if (channel === ONLINE_CHANNELS.TEAM_DISSOLVE) {
        dissolved = true;
        return { ok: true, data: context({ team: null, canCreate: true }) };
      }
      return { ok: false, error: { code: 'NOT_FOUND', message: `未接入:${channel}` } };
    });
    await render();
    await waitFor('.team-section-tabs');
    const teamTab = tabButton('团队管理')!;
    await act(async () => teamTab.click());
    await waitFor('.team-info-head');
    const trigger = Array.from(host.querySelectorAll<HTMLButtonElement>('.team-info-head button')).find(button => button.textContent === '解散')!;
    await act(async () => trigger.click());
    await vi.waitFor(() => expect(document.querySelector('.ant-modal-confirm-btns button')).not.toBeNull());
    const confirm = Array.from(document.querySelectorAll<HTMLButtonElement>('.ant-modal-confirm-btns button')).at(-1)!;
    await act(async () => confirm.click());
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.TEAM_DISSOLVE, team.teamId, expect.objectContaining({ expectedVersion: 1, idempotencyKey: expect.any(String) })));
    await waitFor('.team-setup-view');
  });

  it('lets an ordinary member leave the team after confirmation', async () => {
    identityState.identity = sales as unknown as Record<string, unknown>;
    invoke.mockImplementation(async (channel: string): Promise<Result<unknown>> => {
      if (channel === ONLINE_CHANNELS.TEAM_CONTEXT) return { ok: true, data: context({ team, canCreate: false }) };
      if (channel === ONLINE_CHANNELS.CONTACT_LIST) return { ok: true, data: { items: [contact], total: 1 } };
      if (channel === ONLINE_CHANNELS.TASK_LIST) return { ok: true, data: { items: [task], total: 1 } };
      if (channel === ONLINE_CHANNELS.TEAM_MEMBER) return { ok: true, data: context({ team: null, canCreate: false }) };
      return { ok: false, error: { code: 'NOT_FOUND', message: `未接入:${channel}` } };
    });
    await render();
    await waitFor('.team-section-tabs');
    await act(async () => tabButton('团队管理')!.click());
    await waitFor('.team-info-view');
    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>('.team-info-view button')).find(button => button.textContent === '退出团队')!.click());
    await vi.waitFor(() => expect(document.querySelector('.ant-modal-confirm')).not.toBeNull());
    await act(async () => (Array.from(document.querySelectorAll<HTMLButtonElement>('.ant-modal-confirm-btns button')).at(-1)!).click());
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.TEAM_MEMBER, team.teamId, expect.objectContaining({ userId: sales.userId, action: 'leave', expectedVersion: 1, idempotencyKey: expect.any(String) })));
  });

  it('confirms team dissolution from the management inspector and returns to the organization list', async () => {
    identityState.identity = operations as unknown as Record<string, unknown>;
    const summary = { teamId: operationsGroupId, name: operationsGroup.name, unitType: 'operations' as const, organizationKind: 'operations_group' as const, parentTeamId: companyId, parentTeamName: organization.company.name, depth: 0, childCount: 0, leaderName: operationsGroup.leaderName, memberCount: 1, pendingInvitationCount: 0, createdAt: operationsGroup.createdAt };
    const dissolvableGroup = { ...operationsGroup, canDissolve: true };
    invoke.mockImplementation(async (channel: string): Promise<Result<unknown>> => {
      if (channel === ONLINE_CHANNELS.TEAM_CONTEXT) return { ok: true, data: context({ canCreate: true, canAdmin: true, adminTeams: [summary], organization }) };
      if (channel === ONLINE_CHANNELS.TEAM_DETAIL) return { ok: true, data: { team: dissolvableGroup, outgoingInvitations: [], children: [] } };
      if (channel === ONLINE_CHANNELS.TEAM_CANDIDATES) return { ok: true, data: { items: [], total: 0 } };
      if (channel === ONLINE_CHANNELS.TEAM_DISSOLVE) return { ok: true, data: context({ canCreate: true, canAdmin: true, adminTeams: [], organization }) };
      return { ok: false, error: { code: 'NOT_FOUND', message: `未接入:${channel}` } };
    });
    await render();
    await waitFor('.team-section-tabs');
    const management = tabButton('我的团队')!;
    await act(async () => management.click());
    const groupRow = await waitFor('.team-admin-directory-main') as HTMLButtonElement;
    await act(async () => groupRow.click());
    await waitFor('.team-admin-detail-toolbar');
    const trigger = Array.from(host.querySelectorAll<HTMLButtonElement>('.team-admin-detail-toolbar button')).find(button => button.textContent === '解散')!;
    await act(async () => trigger.click());
    await vi.waitFor(() => expect(document.querySelector('.ant-modal-confirm-btns button')).not.toBeNull());
    const confirm = Array.from(document.querySelectorAll<HTMLButtonElement>('.ant-modal-confirm-btns button')).at(-1)!;
    await act(async () => confirm.click());
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.TEAM_DISSOLVE, operationsGroupId, expect.objectContaining({ expectedVersion: 1, idempotencyKey: expect.any(String) })));
    await waitFor('.team-admin-workspace.is-directory');
  });

  it('lets a member resolve only own attention with a stable retry key and deep links', async () => {
    identityState.identity = sales as unknown as Record<string, unknown>;
    let resolveCalls = 0;
    invoke.mockImplementation(async (channel: string, _itemId?: unknown, input?: unknown): Promise<Result<unknown>> => {
      if (channel === ONLINE_CHANNELS.TEAM_CONTEXT) return { ok: true, data: context({ team, canCreate: false }) };
      if (channel === ONLINE_CHANNELS.CONTACT_LIST) return { ok: true, data: { items: [contact], total: 1 } };
      if (channel === ONLINE_CHANNELS.TASK_LIST) return { ok: true, data: { items: [task], total: 1 } };
      if (channel === ONLINE_CHANNELS.TEAM_ATTENTION_LIST) return { ok: true, data: attentionPage('member', [attentionItem]) };
      if (channel === ONLINE_CHANNELS.TEAM_ATTENTION_RESOLVE) {
        resolveCalls++;
        expect(input).toMatchObject({ expectedVersion: 3, idempotencyKey: expect.any(String), result: '已发送更新报价' });
        return resolveCalls === 1
          ? { ok: false, error: { code: 'UNAVAILABLE', message: '中心响应中断' } }
          : { ok: true, data: { ...attentionItem, status: 'resolved', version: 4, canResolve: false } };
      }
      return { ok: false, error: { code: 'NOT_FOUND', message: `未接入:${channel}` } };
    });
    window.history.replaceState(null, '', `#/team?attention=${attentionItem.itemId}`);
    await render();
    const row = await waitFor('.team-attention-row');
    expect(host.querySelector('.team-attention-panel')?.getAttribute('aria-label')).toBe('我的关注');
    expect(row.textContent).toContain('重要回复');
    expect(row.textContent).toContain('紧急');
    expect(row.textContent).toContain('待确认');
    expect(row.querySelector('.team-attention-links a[href^="#/customers?"]')?.getAttribute('href')).toContain(`centerContact=${contact.contactId}`);
    expect(row.querySelector('.team-attention-links a[href="#/inbox"]')).not.toBeNull();
    expect(Array.from(row.querySelectorAll<HTMLButtonElement>('.team-attention-actions button')).map(button => button.textContent)).toEqual(['完成']);
    await act(async () => Array.from(row.querySelectorAll<HTMLButtonElement>('.team-attention-actions button')).find(button => button.textContent === '完成')!.click());
    const textarea = await waitFor('textarea[aria-label="Atlantic Trade 处理结果"]') as HTMLTextAreaElement;
    await setTextArea(textarea, '已发送更新报价');
    const submit = () => row.querySelector<HTMLButtonElement>('.team-attention-result-form button[type="submit"]')!;
    await act(async () => submit().click());
    await waitFor('.team-attention-error');
    await act(async () => submit().click());
    await flush();
    const calls = invoke.mock.calls.filter(([channel]) => channel === ONLINE_CHANNELS.TEAM_ATTENTION_RESOLVE);
    expect(calls).toHaveLength(2);
    expect((calls[0]![2] as { idempotencyKey: string }).idempotencyKey).toBe((calls[1]![2] as { idempotencyKey: string }).idempotencyKey);
  });

  it('shows direct-report controls from server permissions and no member resolve action for a supervisor', async () => {
    identityState.identity = leader as unknown as Record<string, unknown>;
    const supervisorItem = { ...attentionItem, canAcknowledge: true, canDismiss: true, canResolve: false };
    invoke.mockImplementation(async (channel: string): Promise<Result<unknown>> => {
      if (channel === ONLINE_CHANNELS.TEAM_CONTEXT) return { ok: true, data: context({ team, canCreate: false }) };
      if (channel === ONLINE_CHANNELS.CONTACT_LIST) return { ok: true, data: { items: [contact], total: 1 } };
      if (channel === ONLINE_CHANNELS.TEAM_ATTENTION_LIST) return { ok: true, data: attentionPage('supervisor', [supervisorItem]) };
      if (channel === ONLINE_CHANNELS.TEAM_ATTENTION_ACKNOWLEDGE) return { ok: true, data: { ...supervisorItem, status: 'acknowledged', version: 4, canAcknowledge: false } };
      if (channel === ONLINE_CHANNELS.TEAM_ATTENTION_DISMISS) return { ok: true, data: { ...supervisorItem, status: 'dismissed', version: 4, canAcknowledge: false, canDismiss: false } };
      return { ok: false, error: { code: 'NOT_FOUND', message: `未接入:${channel}` } };
    });
    window.history.replaceState(null, '', `#/team?attention=${attentionItem.itemId}`);
    await render();
    const row = await waitFor('.team-attention-row');
    expect(host.querySelector('.team-attention-panel')?.getAttribute('aria-label')).toBe('团队关注');
    expect(Array.from(row.querySelectorAll<HTMLButtonElement>('.team-attention-actions button')).map(button => button.textContent)).toEqual(['确认', '驳回']);
    await act(async () => Array.from(row.querySelectorAll<HTMLButtonElement>('.team-attention-actions button')).find(button => button.textContent === '确认')!.click());
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.TEAM_ATTENTION_ACKNOWLEDGE, attentionItem.itemId, expect.objectContaining({ expectedVersion: 3, idempotencyKey: expect.any(String) }));
    await act(async () => Array.from(row.querySelectorAll<HTMLButtonElement>('.team-attention-actions button')).find(button => button.textContent === '驳回')!.click());
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.TEAM_ATTENTION_DISMISS, attentionItem.itemId, expect.objectContaining({ expectedVersion: 3, idempotencyKey: expect.any(String) }));
  });

  it('keeps operations attention oversight read-only and opens it from the team deep link', async () => {
    identityState.identity = operations as unknown as Record<string, unknown>;
    const summary = { teamId: operationsGroupId, name: operationsGroup.name, unitType: 'operations' as const, organizationKind: 'operations_group' as const, parentTeamId: companyId, parentTeamName: organization.company.name, depth: 0, childCount: 1, leaderName: leader.displayName, memberCount: 1, pendingInvitationCount: 0, createdAt: team.createdAt };
    const oversightItem = { ...attentionItem, canAcknowledge: false, canDismiss: false, canResolve: false };
    invoke.mockImplementation(async (channel: string): Promise<Result<unknown>> => {
      if (channel === ONLINE_CHANNELS.TEAM_CONTEXT) return { ok: true, data: context({ canAdmin: true, adminTeams: [summary], managedTeams: [summary], organization }) };
      if (channel === ONLINE_CHANNELS.CONTACT_LIST) return { ok: true, data: { items: [], total: 0 } };
      if (channel === ONLINE_CHANNELS.TEAM_ATTENTION_LIST) return { ok: true, data: attentionPage('oversight', [oversightItem]) };
      return { ok: false, error: { code: 'NOT_FOUND', message: `未接入:${channel}` } };
    });
    window.history.replaceState(null, '', `#/team?attention=${attentionItem.itemId}`);
    await render();
    const row = await waitFor('.team-attention-row.is-focused');
    expect(host.querySelector('.team-attention-panel')?.getAttribute('aria-label')).toBe('关注项');
    expect(row.querySelector('.team-attention-actions')).toBeNull();
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.TEAM_ATTENTION_LIST, expect.objectContaining({ limit: 100, offset: 0 }));
  });

  it('filters all server attention statuses without inventing client permissions', async () => {
    identityState.identity = sales as unknown as Record<string, unknown>;
    const done = { ...attentionItem, itemId: '34343434-3434-4434-8434-343434343434', status: 'resolved' as const, version: 4, canResolve: false };
    invoke.mockImplementation(async (channel: string): Promise<Result<unknown>> => {
      if (channel === ONLINE_CHANNELS.TEAM_CONTEXT) return { ok: true, data: context({ team, canCreate: false }) };
      if (channel === ONLINE_CHANNELS.CONTACT_LIST) return { ok: true, data: { items: [contact], total: 1 } };
      if (channel === ONLINE_CHANNELS.TASK_LIST) return { ok: true, data: { items: [task], total: 1 } };
      if (channel === ONLINE_CHANNELS.TEAM_ATTENTION_LIST) return { ok: true, data: attentionPage('member', [attentionItem, done]) };
      return { ok: false, error: { code: 'NOT_FOUND', message: `未接入:${channel}` } };
    });
    window.history.replaceState(null, '', `#/team?attention=${attentionItem.itemId}`);
    await render();
    await waitFor('.team-attention-row');
    expect(host.querySelectorAll('.team-attention-row')).toHaveLength(2);
    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>('.team-attention-filters button')).find(button => button.textContent?.includes('已完成'))!.click());
    expect(host.querySelectorAll('.team-attention-row')).toHaveLength(1);
    expect(host.querySelector('.team-attention-row')?.textContent).toContain('已完成');
    expect(host.querySelector('.team-attention-actions')).toBeNull();
  });

  it('builds notification links back to the exact team attention item', () => {
    const notification = { id: 'delivery-1', eventType: TEAM_ATTENTION_EVENTS.opened, customerId: contact.customerId, version: 3, cursor: '1', createdAt: '2026-10-30T01:00:00Z', read: false, canOpen: true, taskId: attentionItem.itemId } as OnlineNotification;
    expect(notificationResourceHash(notification, attentionItem.itemId)).toBe(`#/team?attention=${attentionItem.itemId}&highlight=${notification.id}`);
  });

  it('opens a team attention notification through the existing message read path', async () => {
    const notification = { id: 'delivery-open', eventType: TEAM_ATTENTION_EVENTS.opened, customerId: contact.customerId, version: 3, cursor: '1', createdAt: '2026-10-30T01:00:00Z', read: false, canOpen: true, taskId: attentionItem.itemId } as OnlineNotification;
    invoke.mockImplementation(async (channel: string): Promise<Result<unknown>> => {
      if (channel === ONLINE_CHANNELS.BOOTSTRAP) return { ok: true, data: { userId: sales.userId, capabilities: ['leads.develop'], scope: 'own' } };
      if (channel === ONLINE_CHANNELS.FEED) return { ok: true, data: { items: [notification], nextCursor: '1', hasMore: false } };
      if (channel === ONLINE_CHANNELS.READ) return { ok: true, data: undefined };
      return { ok: false, error: { code: 'NOT_FOUND', message: `未接入:${channel}` } };
    });
    function Probe() {
      const notifications = useOptionalNotifications();
      return <button id="open-team-attention" type="button" disabled={!notifications?.items.length} onClick={async () => { document.body.dataset.opened = await notifications?.open(notifications.items[0]!) ?? ''; }}>打开关注项</button>;
    }
    await act(async () => root.render(<NotificationProvider><Probe /></NotificationProvider>));
    const openButton = await waitFor('#open-team-attention:not(:disabled)') as HTMLButtonElement;
    await act(async () => openButton.click());
    await flush();
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.READ, notification.id);
    expect(document.body.dataset.opened).toBe(attentionItem.itemId);
  });

  it('keeps the 824px organization layout inside a no-overflow toolbar and inspector structure', () => {
    const css = readFileSync(resolve('src/renderer/pages/team/team-workspace.css'), 'utf8');
    const personalCss = readFileSync(resolve('src/renderer/pages/team/personal-workspace.css'), 'utf8');
    const customerCss = readFileSync(resolve('src/renderer/pages/customers/customers.css'), 'utf8');
    expect(css).toContain('@media (max-width: 900px)');
    expect(css).toContain('.team-workspace-primary-action { margin-left: auto;');
    expect(css).toContain('.team-admin-workspace { display: grid;');
    expect(css).toContain('.team-admin-directory-root { min-height: 50px; display: grid;');
    expect(css).toContain('.team-monitoring-metrics { min-height: 76px;');
    expect(css).toContain('.team-admin-toolbar-actions { grid-column: 1 / -1; min-width: 0; width: 100%; flex-wrap: wrap; }');
    expect(css).toContain('.team-admin-workspace.is-directory .team-admin-rail { width: 190px; min-width: 170px; }');
    expect(css).toContain('.team-setup-view { display: flex; flex-direction: column; gap: 10px; padding: 12px 18px 14px; overflow: hidden; }');
    expect(css).toContain('.team-candidate-row.is-locked { color: var(--workspace-muted); background: var(--workspace-surface-soft); cursor: default; opacity: .78; }');
    expect(css).not.toContain('.team-control-picker');
    expect(css).toContain('.team-monitoring-view {');
    expect(personalCss).toContain('.personal-actions-panel, .personal-task-panel { border:');
    expect(css).toContain('min-width: 0;');
    expect(css).toContain('.team-monitoring-body { grid-template-columns: minmax(0, 1fr); }');
    expect(css).toContain('.team-collaboration-log {');
    expect(css).toContain('.team-collaboration-tools button:disabled {');
    expect(css).toContain('.team-admin-overview-aside > .team-admin-activity-drawer.is-overview { height: auto; min-height: 160px; max-height: 50%; flex: 0 0 50%; resize: none;');
    expect(css).toContain('.team-monitoring-member-row { grid-template-columns: 28px minmax(90px, 1fr) repeat(3, 38px) 14px; }');
    expect(css).toContain('.team-performance-form { grid-template-columns: repeat(2, minmax(0, 1fr)); }');
    expect(css).toContain('.team-performance-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }');
    expect(css).toContain('.team-monitoring-members > .ant-empty');
    expect(customerCss).toContain('@media(max-width:824px)');
    expect(customerCss).toContain('.customer-grade-form,.customer-grade-panel.is-compact .customer-grade-form{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}');
    expect(personalCss).toContain('@media (max-width: 900px)');
    expect(personalCss).toContain('.team-attention-panel { max-height: 330px; }');
    expect(personalCss).toContain('.team-attention-actions { grid-column: 3; grid-row: 2; }');
  });

  it('opens the team workspace for every signed-in account without granting creation', async () => {
    identityState.identity = auditor as unknown as Record<string, unknown>;
    invoke.mockImplementation(async (channel: string): Promise<Result<unknown>> => {
      if (channel === ONLINE_CHANNELS.TEAM_CONTEXT) return { ok: true, data: context({ team: null, canCreate: false }) };
      return { ok: false, error: { code: 'NOT_FOUND', message: `未接入:${channel}` } };
    });
    await render();
    await waitFor('.team-setup-view');
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.TEAM_CONTEXT, undefined);
    expect(host.querySelector('.team-setup-view')?.textContent).not.toContain('创建团队');
    expect(host.querySelector('.team-page-state')).toBeNull();
  });
});
