// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomerGradeItem, CustomerGradeOverride, CustomerGradePage, DurationMetric, SalesPerformanceOverview, TeamAdminSummary } from '../../src/shared/online-crm';
import { ONLINE_CHANNELS } from '../../src/shared/online-crm';

const identityState = vi.hoisted(() => ({
  identity: { userId: 'operations-1', crmRoles: ['operations'], identityAdmin: false } as Record<string, unknown>,
  baseUrl: 'https://center.test',
  status: 'authenticated',
}));

vi.mock('../../src/renderer/IdentityContext', () => ({
  useIdentity: () => identityState,
  useOptionalIdentity: () => identityState,
}));

vi.mock('antd', async importOriginal => {
  const actual = await importOriginal<typeof import('antd')>();
  const Button = ({ children, onClick, disabled, htmlType = 'button', loading, icon }: {
    children?: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    htmlType?: 'button' | 'submit' | 'reset';
    loading?: boolean;
    icon?: ReactNode;
  }) => <button type={htmlType} disabled={disabled || loading} onClick={onClick}>{icon}{children}</button>;
  const field = ({ value, onChange, disabled, maxLength, type = 'text', ...props }: {
    value?: string;
    onChange?: (event: { target: { value: string } }) => void;
    disabled?: boolean;
    maxLength?: number;
    type?: string;
    [key: string]: unknown;
  }) => <input aria-label={props['aria-label'] as string | undefined} type={type} disabled={disabled} maxLength={maxLength} value={value ?? ''} onChange={event => onChange?.({ target: { value: event.target.value } })} />;
  const Input = Object.assign(field, { TextArea: field });
  const Select = ({ value, onChange, disabled, options = [], ...props }: {
    value?: string;
    onChange?: (value: string) => void;
    disabled?: boolean;
    options?: Array<{ value: string; label: ReactNode }>;
    [key: string]: unknown;
  }) => <select aria-label={props['aria-label'] as string | undefined} disabled={disabled} value={value ?? ''} onChange={event => onChange?.(event.target.value)}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>;
  return {
    ...actual,
    Alert: ({ message }: { message: ReactNode }) => <div role="alert">{message}</div>,
    Button,
    Empty: ({ description }: { description?: ReactNode }) => <div>{description}</div>,
    Input,
    Pagination: () => <div />,
    Select,
    Spin: () => <span>读取中</span>,
    Tag: ({ children }: { children: ReactNode }) => <span>{children}</span>,
    message: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  };
});

import { CustomerGradePanel } from '../../src/renderer/pages/customers/CenterContactDetail';
import { TeamPerformanceView } from '../../src/renderer/pages/team/TeamMonitoringView';

const customerId = '11111111-1111-4111-8111-111111111111';
const memberId = '22222222-2222-4222-8222-222222222222';
const teamId = '33333333-3333-4333-8333-333333333333';
const batchId = '44444444-4444-4444-8444-444444444444';

const shortDuration: DurationMetric = { sampleCount: 2, minimumSampleSize: 5, sufficient: false, medianSeconds: 3_600, p90Seconds: 7_200 };
const sufficientDuration: DurationMetric = { sampleCount: 6, minimumSampleSize: 5, sufficient: true, medianSeconds: 5_400, p90Seconds: 14_400 };
const team: TeamAdminSummary = {
  teamId, name: '华东销售组', unitType: 'sales_team', organizationKind: 'sales_team', parentTeamId: null, parentTeamName: '运营组',
  depth: 1, childCount: 0, leaderName: 'Leader', memberCount: 8, pendingInvitationCount: 0, createdAt: '2026-10-30T00:00:00Z', version: 1,
};
const performance: SalesPerformanceOverview = {
  scope: 'leader',
  generatedAt: '2026-10-30T03:00:00Z',
  window: { from: '2026-08-01T00:00:00.000Z', to: '2026-10-30T23:59:59.999Z' },
  groupBy: 'lead',
  total: 1,
  items: [{
    key: memberId, label: 'Sales One', memberUserId: memberId, memberName: 'Sales One', teamId, teamName: team.name,
    claimCount: 7, customerCount: 6, completedTaskCount: 4, validReplyCount: 2, wonOpportunityCount: 1,
    metrics: {
      claimToFirstAction: shortDuration,
      claimToValidReply: sufficientDuration,
      claimToWon: shortDuration,
      repeatPurchase: {
        repeatPurchaseCount: 1, repeatPurchaseCustomers: 1, wonCustomers: 2,
        rate: { count: 1, total: 2, rate: 0.5, sampleCount: 2, minimumSampleSize: 5, sufficient: false },
      },
    },
  }],
};

function gradePage(scope: CustomerGradePage['scope'], override: CustomerGradeOverride | null = null): CustomerGradePage {
  const item: CustomerGradeItem = {
    customerId, companyName: 'Atlantic Trade', ownerUserId: memberId, ownerName: 'Sales One', teamId, teamName: team.name,
    origin: 'operations', computedGrade: 'B', effectiveGrade: override?.grade ?? 'B', source: override ? 'manual' : 'computed',
    reasons: ['valid_reply'], signals: { validReplyCount: 1, wonOpportunityCount: 0, repeatPurchaseCount: 0, openOpportunityCount: 1 }, override,
  };
  return {
    scope, generatedAt: '2026-10-30T03:00:00Z', window: { from: '2026-08-01T00:00:00.000Z', to: '2026-10-30T23:59:59.999Z' },
    thresholds: { gradeAWonOpportunities: 1, gradeAValidReplies: 3, gradeBValidReplies: 1, gradeBOpenOpportunities: 1 },
    items: [item], total: 1,
  };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('CP7 performance and customer-grade renderer', () => {
  let root: Root;
  let host: HTMLDivElement;
  let client: QueryClient;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    identityState.identity = { userId: 'operations-1', crmRoles: ['operations'], identityAdmin: false };
    identityState.status = 'authenticated';
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
    document.body.innerHTML = '';
  });

  async function render(node: ReactNode) {
    await act(async () => root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>));
    await act(flush);
  }

  const setInput = async (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
  };
  const setSelect = async (select: HTMLSelectElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(select, value); select.dispatchEvent(new Event('change', { bubbles: true })); });
  };

  it('shows median/P90 and a sample-short state without a rank or allocation action', async () => {
    const invoke = vi.fn(async () => ({ ok: true as const, data: performance }));
    Object.defineProperty(window, 'api', { configurable: true, value: { invoke } });
    await render(<TeamPerformanceView teams={[team]} online />);
    expect(host.querySelector('.team-performance-row')).not.toBeNull();
    expect(host.textContent).toContain('中位数');
    expect(host.textContent).toContain('P90');
    expect(host.textContent).toContain('2/5 样本');
    expect(host.querySelector('.team-performance-rank')).toBeNull();
    expect(host.textContent).not.toContain('自动分配');
  });

  it('sends team, stratum, source, batch and country filters through the existing performance channel', async () => {
    const invoke = vi.fn(async () => ({ ok: true as const, data: performance }));
    Object.defineProperty(window, 'api', { configurable: true, value: { invoke } });
    await render(<TeamPerformanceView teams={[team]} online />);
    await setSelect(host.querySelector<HTMLSelectElement>('select[aria-label="选择绩效团队"]')!, teamId);
    await setSelect(host.querySelector<HTMLSelectElement>('select[aria-label="绩效分组"]')!, 'source');
    await setInput(host.querySelector<HTMLInputElement>('input[aria-label="来源筛选"]')!, 'operations-import');
    await setInput(host.querySelector<HTMLInputElement>('input[aria-label="批次筛选"]')!, batchId);
    await setInput(host.querySelector<HTMLInputElement>('input[aria-label="国家筛选"]')!, 'BR');
    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === '应用')!.click());
    await act(flush);
    expect(invoke).toHaveBeenLastCalledWith(ONLINE_CHANNELS.SALES_PERFORMANCE, expect.objectContaining({
      teamId, groupBy: 'source', source: 'operations-import', batchId, country: 'BR', limit: 25, offset: 0,
    }));
  });

  it('keeps self metrics on the self scope without rendering a team selector', async () => {
    const invoke = vi.fn(async () => ({ ok: true as const, data: { ...performance, scope: 'self' as const, items: performance.items.map(item => ({ ...item, teamId: null, teamName: null })) } }));
    Object.defineProperty(window, 'api', { configurable: true, value: { invoke } });
    await render(<TeamPerformanceView online />);
    expect(host.querySelector('select[aria-label="选择绩效团队"]')).toBeNull();
    expect(host.textContent).toContain('我的绩效');
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.SALES_PERFORMANCE, expect.not.objectContaining({ teamId: expect.anything() }));
  });

  it('lets an operator set a manual grade with reason, version and a stable retry key without mutating owner or stage', async () => {
    let override: CustomerGradeOverride | null = null;
    let writes = 0;
    const invoke = vi.fn(async (channel: string, input?: unknown) => {
      if (channel === ONLINE_CHANNELS.SALES_PERFORMANCE_GRADES) return { ok: true as const, data: gradePage('operations', override) };
      if (channel === ONLINE_CHANNELS.SALES_PERFORMANCE_GRADE_SET) {
        writes++;
        if (writes === 1) return { ok: false as const, error: { code: 'UNAVAILABLE', message: '响应丢失' } };
        const body = input as { grade: 'A' | 'B' | 'C'; reason: string };
        override = { customerId, grade: body.grade, reason: body.reason, actorId: 'operations-1', actorName: 'Operations One', version: 1, createdAt: '2026-10-30T03:00:00Z', updatedAt: '2026-10-30T03:00:00Z' };
        return { ok: true as const, data: { customerId, override } };
      }
      return { ok: false as const, error: { code: 'NOT_FOUND', message: channel } };
    });
    Object.defineProperty(window, 'api', { configurable: true, value: { invoke } });
    await render(<CustomerGradePanel customerId={customerId} />);
    expect(host.textContent).toContain('有效客户回复');
    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === '调整等级')!.click());
    await setSelect(host.querySelector<HTMLSelectElement>('select[aria-label="客户等级"]')!, 'A');
    await setInput(host.querySelector<HTMLInputElement>('input[aria-label="等级调整原因"]')!, '重点客户，人工升级');
    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === '保存等级')!.click());
    await act(flush);
    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === '保存等级')!.click());
    await act(flush);
    const calls = invoke.mock.calls.filter(call => call[0] === ONLINE_CHANNELS.SALES_PERFORMANCE_GRADE_SET);
    expect(calls).toHaveLength(2);
    expect(calls[0]![1]).toMatchObject({ customerId, expectedVersion: 0, grade: 'A', reason: '重点客户，人工升级' });
    expect((calls[0]![1] as { idempotencyKey: string }).idempotencyKey).toBe((calls[1]![1] as { idempotencyKey: string }).idempotencyKey);
    expect(invoke.mock.calls.some(call => [ONLINE_CHANNELS.CONTACT_UPDATE, ONLINE_CHANNELS.CONTACT_FOLLOWUP, ONLINE_CHANNELS.UPDATE_CUSTOMER].includes(call[0] as never))).toBe(false);
  });

  it('clears a manual override with the existing version and reason', async () => {
    const override: CustomerGradeOverride = { customerId, grade: 'A', reason: '人工重点', actorId: 'operations-1', actorName: 'Operations One', version: 2, createdAt: '2026-10-30T03:00:00Z', updatedAt: '2026-10-30T04:00:00Z' };
    const invoke = vi.fn(async (channel: string, input?: unknown) => {
      if (channel === ONLINE_CHANNELS.SALES_PERFORMANCE_GRADES) return { ok: true as const, data: gradePage('operations', override) };
      if (channel === ONLINE_CHANNELS.SALES_PERFORMANCE_GRADE_CLEAR) return { ok: true as const, data: { customerId, override: null } };
      return { ok: false as const, error: { code: 'NOT_FOUND', message: `${channel}:${String(input)}` } };
    });
    Object.defineProperty(window, 'api', { configurable: true, value: { invoke } });
    await render(<CustomerGradePanel customerId={customerId} />);
    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === '清除人工')!.click());
    await setInput(host.querySelector<HTMLInputElement>('input[aria-label="等级调整原因"]')!, '恢复自动规则');
    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === '确认清除')!.click());
    await act(flush);
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.SALES_PERFORMANCE_GRADE_CLEAR, expect.objectContaining({ customerId, expectedVersion: 2, reason: '恢复自动规则', idempotencyKey: expect.any(String) }));
  });

  it('keeps sales grade read-only and mounts the same panel in contact and monitor detail', async () => {
    identityState.identity = { userId: 'sales-1', crmRoles: ['sales'], identityAdmin: false };
    const invoke = vi.fn(async () => ({ ok: true as const, data: gradePage('self') }));
    Object.defineProperty(window, 'api', { configurable: true, value: { invoke } });
    await render(<CustomerGradePanel customerId={customerId} />);
    expect(host.textContent).toContain('B');
    expect(host.textContent).toContain('有效客户回复');
    expect(host.textContent).not.toContain('调整等级');
    expect(host.textContent).not.toContain('清除人工');

    const source = readFileSync(resolve('src/renderer/pages/customers/CenterContactDetail.tsx'), 'utf8');
    expect((source.match(/<CustomerGradePanel/g) ?? [])).toHaveLength(2);
    expect(source).toContain('<CustomerGradePanel customerId={gradeCustomerId} readOnly compact />');
  });

  it('does not crash the customer detail when a grade payload arrives without an effective grade', async () => {
    const malformed = gradePage('self');
    malformed.items = [{ ...malformed.items[0]!, effectiveGrade: undefined } as unknown as CustomerGradeItem];
    const invoke = vi.fn(async () => ({ ok: true as const, data: malformed }));
    Object.defineProperty(window, 'api', { configurable: true, value: { invoke } });
    await render(<CustomerGradePanel customerId={customerId} />);
    expect(host.textContent).toContain('客户分级');
    expect(host.textContent).toContain('—');
  });

  it('keeps the performance and grade layouts compact at 824px', () => {
    const teamCss = readFileSync(resolve('src/renderer/pages/team/team-workspace.css'), 'utf8');
    const customerCss = readFileSync(resolve('src/renderer/pages/customers/customers.css'), 'utf8');
    expect(teamCss).toContain('@media (max-width: 900px)');
    expect(teamCss).toContain('.team-performance-form { grid-template-columns: repeat(2, minmax(0, 1fr)); }');
    expect(teamCss).toContain('.team-performance-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }');
    expect(customerCss).toContain('@media(max-width:824px)');
    expect(customerCss).toContain('.customer-grade-form,.customer-grade-panel.is-compact .customer-grade-form{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}');
  });
});
