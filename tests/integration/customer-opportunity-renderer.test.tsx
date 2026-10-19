// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Opportunities } from '../../src/renderer/pages/customers/Opportunities';
import { CustomersPage } from '../../src/renderer/pages/customers/CustomersPage';
import { ONLINE_CHANNELS as ONLINE, ONLINE_LIMITS, OPPORTUNITY_LIMITS } from '../../src/shared/online-crm';
const identity = vi.hoisted(() => ({ userId: 'sales-a', crmRoles: ['sales'], crmCapabilities: ['leads.create', 'leads.develop'] }));
vi.mock('../../src/renderer/IdentityContext', () => ({ useOptionalIdentity: () => ({ identity, refresh: vi.fn() }) }));

const CHANNEL = {
  list: 'online:opportunity-list',
  create: 'online:opportunity-create',
  stage: 'online:opportunity-stage',
  detail: 'online:opportunity-detail',
} as const;

const customer = {
  customerId: 'customer-a',
  companyName: 'Synthetic Logistics',
  version: 3,
  stage: 'cold',
  state: 'owned',
  origin: 'personal',
  contactCount: 0,
  ownerUserId: 'sales-a',
  source: 'manual',
  sourceDetail: '',
  customerKey: '',
  contacts: [],
  activities: [],
};

const opportunity = (id: string, title: string, stage = 'inquiry') => ({
  opportunityId: id,
  customerId: 'customer-a',
  title,
  description: '',
  pol: id === 'opp-a' ? 'CNSHA' : 'CNNGB',
  pod: id === 'opp-a' ? 'USLAX' : 'NLRTM',
  containerType: '40HQ',
  source: 'manual',
  stage,
  amount: null,
  currency: null,
  lostReason: null,
  evidence: null,
  version: 1,
  ownerUserId: 'sales-a',
  ownerName: 'User A',
  createdBy: 'sales-a',
  createdAt: '2026-10-13T01:00:00.000Z',
  updatedAt: '2026-10-13T01:00:00.000Z',
  closedAt: null,
  closedBy: null,
  canManage: true,
  history: [],
});

describe('customer opportunity renderer', () => {
  let root: Root;
  let host: HTMLDivElement;
  let invoke: ReturnType<typeof vi.fn>;
  let rows: ReturnType<typeof opportunity>[];
  let ticks: Array<() => void>;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.history.replaceState(null, '', '#/customers?customerId=customer-a');
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
    ticks = [];
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, delay: number) => { if (delay === ONLINE_LIMITS.pollMs) ticks.push(callback); return ticks.length; }) as typeof setInterval);
    rows = [opportunity('opp-a', '上海到洛杉矶'), opportunity('opp-b', '宁波到鹿特丹')];
    invoke = vi.fn(async (channel: string, input: unknown) => {
      if (channel === CHANNEL.list) return { ok: true, data: { items: structuredClone(rows), total: rows.length } };
      if (channel === CHANNEL.detail) return { ok: true, data: structuredClone(rows.find(row => row.opportunityId === input)) };
      if (channel === CHANNEL.stage) {
        const request = input as { opportunityId: string; stage: string };
        const index = rows.findIndex(row => row.opportunityId === request.opportunityId);
        rows[index] = { ...rows[index], ...request, version: rows[index].version + 1 };
        return { ok: true, data: structuredClone(rows[index]) };
      }
      if (channel === CHANNEL.create) {
        const request = input as { title: string };
        const created = { ...opportunity('opp-new', request.title), pol: null, pod: null, containerType: null };
        rows.push(created);
        return { ok: true, data: created };
      }
      return { ok: true, data: {} };
    });
    Object.defineProperty(window, 'api', { configurable: true, value: { invoke } });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  const flush = () => new Promise(resolve => setTimeout(resolve, 20));
  const mount = async (props: { detail?: unknown; canCreate?: boolean } = {}) => act(async () => {
    root.render(<Opportunities detail={(props.detail ?? customer) as never} canCreate={props.canCreate ?? true} />);
    await flush();
  });
  const click = async (label: string) => act(async () => { Array.from(host.querySelectorAll('button')).find(button => button.textContent?.replace(/\s/g, '') === label)!.click(); await flush(); });
  const fill = async (label: string, value: string) => act(async () => {
    const field = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
    const prototype = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const choose = async (id: string, value: string) => act(async () => {
    const select = host.querySelector<HTMLSelectElement>(`[aria-label="商机阶段-${id}"]`)!;
    select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); await flush();
  });

  it('renders two opportunities for one customer without mixing route fields', async () => {
    await mount();
    expect(document.body.textContent).toContain('上海到洛杉矶');
    expect(document.body.textContent).toContain('宁波到鹿特丹');
    expect(document.body.textContent).toContain('CNSHA → USLAX');
    expect(document.body.textContent).toContain('CNNGB → NLRTM');
  });

  it('updates only the selected opportunity stage', async () => {
    await mount();
    const first = document.querySelector<HTMLSelectElement>('[aria-label="商机阶段-opp-a"]')!;
    await act(async () => {
      first.value = 'quote_sent';
      first.dispatchEvent(new Event('change', { bubbles: true }));
      await flush();
    });
    await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="保存阶段-opp-a"]')!.click(); await flush(); });
    const write = invoke.mock.calls.find(call => call[0] === CHANNEL.stage);
    expect(write?.[1]).toMatchObject({ opportunityId: 'opp-a', stage: 'quote_sent', expectedVersion: 1 });
    expect(invoke.mock.calls.filter(call => call[0] === CHANNEL.stage)).toHaveLength(1);
    expect(host.querySelector('#opportunity-opp-a .customer-opportunity-heading')!.textContent).toContain('已报价');
    expect(host.querySelector('#opportunity-opp-b .customer-opportunity-heading')!.textContent).toContain('询价');
  });

  it('keeps the exact stage request for retry after an unknown response', async () => {
    let attempts = 0;
    invoke.mockImplementation(async (channel: string, input: unknown) => {
      if (channel === CHANNEL.list) return { ok: true, data: { items: [opportunity('opp-a', '上海到洛杉矶')], total: 1 } };
      if (channel === CHANNEL.stage) {
        attempts += 1;
        return attempts === 1 ? { ok: false, error: { code: 'UNAVAILABLE', message: '连接中断' } } : { ok: true, data: opportunity('opp-a', '上海到洛杉矶', 'closed_lost') };
      }
      return { ok: true, data: {} };
    });
    await mount();
    const select = document.querySelector<HTMLSelectElement>('[aria-label="商机阶段-opp-a"]')!;
    await act(async () => { select.value = 'closed_lost'; select.dispatchEvent(new Event('change', { bubbles: true })); await flush(); });
    const reason = document.querySelector<HTMLInputElement>('[aria-label="丢单原因-opp-a"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(reason, '预算冻结'); reason.dispatchEvent(new Event('input', { bubbles: true })); reason.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="保存阶段-opp-a"]')!.click(); await flush(); });
    const first = invoke.mock.calls.find(call => call[0] === CHANNEL.stage)?.[1];
    expect(first).toMatchObject({ opportunityId: 'opp-a', stage: 'closed_lost', lostReason: '预算冻结' });
    expect(document.body.textContent?.replace(/\s/g, '')).toContain('重试');
    await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="保存阶段-opp-a"]')!.click(); await flush(); });
    const writes = invoke.mock.calls.filter(call => call[0] === CHANNEL.stage).map(call => call[1]);
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
  });

  it('creates a title-only opportunity without inventing route or currency values', async () => {
    await mount();
    expect(host.querySelector('[aria-label="商机标题"]')).toBeNull();
    await click('新增商机'); await fill('商机标题', '新需求'); await click('创建商机');
    const input = invoke.mock.calls.find(call => call[0] === CHANNEL.create)?.[1];
    expect(input).toMatchObject({ title: '新需求', customerId: 'customer-a', expectedCustomerVersion: 3 });
    for (const field of ['amount', 'currency', 'pol', 'pod', 'containerType']) expect(input).not.toHaveProperty(field);
    expect(host.textContent).toContain('新需求');
  });

  it('requires won evidence and paired amount/currency before issuing the stage write', async () => {
    await mount(); await choose('opp-a', 'closed_won'); await click('保存阶段');
    expect(host.textContent).toContain('请填写成交证据');
    expect(invoke.mock.calls.some(call => call[0] === CHANNEL.stage)).toBe(false);
    await fill('成交证据-opp-a', 'Booking SYN-1001');
    await fill('商机-opp-a-金额', '1200.50'); await click('保存阶段');
    expect(host.textContent).toContain('金额和币种请一并填写');
    await fill('商机-opp-a-币种', 'eur'); await click('保存阶段');
    expect(invoke.mock.calls.find(call => call[0] === CHANNEL.stage)?.[1]).toMatchObject({ stage: 'closed_won', evidence: 'Booking SYN-1001', amount: '1200.50', currency: 'EUR' });
    expect(host.querySelector('[aria-label="商机阶段-opp-a"]')).toBeNull();
  });

  it('locks an explicit rejection until fresh detail and list complete, then uses the refreshed version', async () => {
    await mount(); await choose('opp-a', 'quote_sent');
    const normal = invoke.getMockImplementation()!;
    let resolveDetail!: (value: unknown) => void;
    let rejected = false;
    invoke.mockImplementation((channel: string, input: unknown) => {
      if (channel === CHANNEL.stage && !rejected) { rejected = true; return Promise.resolve({ ok: false, error: { code: 'CONFLICT', message: '版本已变化' } }); }
      if (channel === CHANNEL.detail) return new Promise(resolve => { resolveDetail = resolve; });
      return normal(channel, input);
    });
    await click('保存阶段');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="商机阶段-opp-a"]')!.disabled).toBe(true);
    rows[0].version = 7;
    await act(async () => { resolveDetail({ ok: true, data: structuredClone(rows[0]) }); await flush(); });
    expect(host.querySelector<HTMLSelectElement>('[aria-label="商机阶段-opp-a"]')!.disabled).toBe(false);
    await click('保存阶段');
    const writes = invoke.mock.calls.filter(call => call[0] === CHANNEL.stage).map(call => call[1]);
    expect(writes[0]).toMatchObject({ expectedVersion: 1 });
    expect(writes[1]).toMatchObject({ expectedVersion: 7 });
    expect(writes[1]).not.toEqual(writes[0]);
  });

  it('does not let a list requested before a stage mutation restore its stale stage', async () => {
    await mount();
    const normal = invoke.getMockImplementation()!;
    const stale = structuredClone(rows);
    let resolveList!: (value: unknown) => void;
    let delay = true;
    invoke.mockImplementation((channel: string, input: unknown) => {
      if (channel === CHANNEL.list && delay) { delay = false; return new Promise(resolve => { resolveList = resolve; }); }
      return normal(channel, input);
    });
    await act(async () => { ticks[0](); await flush(); });
    await choose('opp-a', 'quote_sent'); await click('保存阶段');
    await act(async () => { resolveList({ ok: true, data: { items: stale, total: stale.length } }); await flush(); });
    expect(host.querySelector('#opportunity-opp-a .customer-opportunity-heading')!.textContent).toContain('已报价');
  });

  it('freezes a malformed mutation success for same-key retry', async () => {
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation((channel: string, input: unknown) => channel === CHANNEL.create ? Promise.resolve({ ok: true, data: null }) : normal(channel, input));
    await mount(); await click('新增商机'); await fill('商机标题', 'Unknown write'); await click('创建商机');
    expect(host.textContent).toContain('商机保存响应无效');
    expect(host.querySelector<HTMLInputElement>('[aria-label="商机标题"]')!.disabled).toBe(true);
    await click('重试');
    const writes = invoke.mock.calls.filter(call => call[0] === CHANNEL.create).map(call => call[1]);
    expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
  });

  it('discards a delayed mutation on customer/account unmount without invoking parent callbacks', async () => {
    const changed = vi.fn(); const selected = vi.fn();
    let resolveWrite!: (value: unknown) => void;
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation((channel: string, input: unknown) => channel === CHANNEL.stage ? new Promise(resolve => { resolveWrite = resolve; }) : normal(channel, input));
    await act(async () => { root.render(<Opportunities key="account-a:customer-a" detail={customer as never} canCreate onChange={changed} onSelect={selected} />); await flush(); });
    await choose('opp-a', 'quote_sent'); await click('保存阶段');
    await act(async () => { root.render(<div>Other customer</div>); await flush(); });
    await act(async () => { resolveWrite({ ok: true, data: opportunity('opp-a', 'Old customer', 'quote_sent') }); await flush(); });
    expect(changed).not.toHaveBeenCalled(); expect(selected).not.toHaveBeenCalled();
    expect(host.textContent).toBe('Other customer');
  });

  it('resolves a deep-linked opportunity outside the first page and rejects cross-customer detail', async () => {
    window.history.replaceState(null, '', '#/customers?customerId=customer-a&opportunityId=opp-external');
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation((channel: string, input: unknown) => channel === CHANNEL.detail ? Promise.resolve({ ok: true, data: opportunity('opp-external', 'Deep-linked demand') }) : normal(channel, input));
    await mount();
    expect(host.querySelector('#opportunity-opp-external')?.className).toContain('customer-opportunity-highlight');
    expect(host.textContent).toContain('Deep-linked demand');
    invoke.mockImplementation((channel: string, input: unknown) => channel === CHANNEL.detail ? Promise.resolve({ ok: true, data: { ...opportunity('opp-other', 'Other customer secret'), customerId: 'customer-b' } }) : normal(channel, input));
    await act(async () => { window.history.replaceState(null, '', '#/customers?customerId=customer-a&opportunityId=opp-other'); window.dispatchEvent(new Event('hashchange')); await flush(); });
    expect(host.textContent).not.toContain('Other customer secret');
    expect(host.textContent).toContain('商机详情响应无效');
  });

  it('bounds list paging and exposes no stage mutation for read-only or terminal rows', async () => {
    rows[0] = { ...rows[0], stage: 'closed_won', evidence: 'Booking done', amount: '80', currency: 'EUR' } as typeof rows[number];
    rows[1].canManage = false;
    await mount({ canCreate: false });
    expect(host.textContent).toContain('80 EUR');
    expect(host.textContent).toContain('Booking done');
    expect(host.querySelectorAll('select')).toHaveLength(0);
    expect(Array.from(host.querySelectorAll('button')).some(button => button.textContent === '新增商机')).toBe(false);
    expect(invoke.mock.calls.find(call => call[0] === CHANNEL.list)?.[1]).toEqual({ customerId: 'customer-a', offset: 0, limit: OPPORTUNITY_LIMITS.page });
  });

  it('returns the full selected opportunity for existing followup/task association', async () => {
    const selected = vi.fn();
    await act(async () => { root.render(<Opportunities detail={customer as never} canCreate selectedOpportunityId="opp-b" onSelect={selected} />); await flush(); });
    expect(host.querySelector('#opportunity-opp-b')!.textContent?.replace(/\s/g, '')).toContain('取消跟进');
    await click('跟进');
    expect(selected).toHaveBeenLastCalledWith(expect.objectContaining({ opportunityId: 'opp-a', title: '上海到洛杉矶' }));
    await act(async () => { root.render(<Opportunities detail={customer as never} canCreate selectedOpportunityId="opp-a" onSelect={selected} />); await flush(); });
    await click('取消跟进');
    expect(selected).toHaveBeenLastCalledWith(undefined);
    await act(async () => { root.render(<Opportunities detail={customer as never} canCreate selectedOpportunityId={undefined} onSelect={selected} />); await flush(); });
    expect(host.querySelector('#opportunity-opp-a')!.textContent?.replace(/\s/g, '')).not.toContain('取消跟进');
  });

  it('refreshes a focused opportunity outside the first list page on every poll', async () => {
    window.history.replaceState(null, '', '#/customers?customerId=customer-a&opportunityId=opp-external');
    let focused = opportunity('opp-external', 'External demand');
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation((channel: string, input: unknown) => channel === CHANNEL.detail ? Promise.resolve({ ok: true, data: structuredClone(focused) }) : normal(channel, input));
    await mount();
    focused = { ...focused, stage: 'negotiation', version: 4 };
    await act(async () => { ticks[0](); await flush(); });
    expect(host.querySelector('#opportunity-opp-external .customer-opportunity-heading')!.textContent).toContain('谈判中');
    expect(invoke.mock.calls.filter(call => call[0] === CHANNEL.detail)).toHaveLength(2);
  });

  it('discards a focused detail requested before its stage mutation', async () => {
    window.history.replaceState(null, '', '#/customers?customerId=customer-a&opportunityId=opp-external');
    let focused = opportunity('opp-external', 'External demand');
    let resolveDetail!: (value: unknown) => void;
    let reads = 0;
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation((channel: string, input: unknown) => {
      if (channel === CHANNEL.detail) {
        reads++;
        if (reads === 2) return new Promise(resolve => { resolveDetail = resolve; });
        return Promise.resolve({ ok: true, data: structuredClone(focused) });
      }
      if (channel === CHANNEL.stage) { focused = { ...focused, stage: 'quote_sent', version: 2 }; return Promise.resolve({ ok: true, data: structuredClone(focused) }); }
      return normal(channel, input);
    });
    await mount();
    const stale = structuredClone(focused);
    await act(async () => { ticks[0](); await flush(); });
    await choose('opp-external', 'quote_sent'); await click('保存阶段');
    await act(async () => { resolveDetail({ ok: true, data: stale }); await flush(); });
    expect(host.querySelector('#opportunity-opp-external .customer-opportunity-heading')!.textContent).toContain('已报价');
  });

  it('holds the parent lock through an unknown mutation and releases it on success or unmount', async () => {
    const parentLock = vi.fn();
    const normal = invoke.getMockImplementation()!;
    let resolveWrite!: (value: unknown) => void;
    invoke.mockImplementation((channel: string, input: unknown) => channel === CHANNEL.stage ? new Promise(resolve => { resolveWrite = resolve; }) : normal(channel, input));
    await act(async () => { root.render(<Opportunities detail={customer as never} canCreate onLocked={parentLock} />); await flush(); });
    await choose('opp-a', 'quote_sent'); await click('保存阶段');
    expect(parentLock).toHaveBeenLastCalledWith(true);
    await act(async () => { resolveWrite({ ok: false, error: { code: 'UNAVAILABLE', message: 'Lost response' } }); await flush(); });
    expect(parentLock).toHaveBeenLastCalledWith(true);
    await click('重试');
    await act(async () => { rows[0].stage = 'quote_sent'; resolveWrite({ ok: true, data: rows[0] }); await flush(); });
    expect(parentLock).toHaveBeenLastCalledWith(false);
    await choose('opp-a', 'negotiation'); await click('保存阶段');
    expect(parentLock).toHaveBeenLastCalledWith(true);
    await act(async () => { root.render(<div>Exited identity</div>); await flush(); });
    expect(parentLock).toHaveBeenLastCalledWith(false);
  });

  it('does not restore a canceled parent association when a pending stage write succeeds', async () => {
    const oldSelect = vi.fn(); const currentSelect = vi.fn();
    const oldChange = vi.fn(); const currentChange = vi.fn();
    const normal = invoke.getMockImplementation()!;
    let resolveWrite!: (value: unknown) => void;
    invoke.mockImplementation((channel: string, input: unknown) => channel === CHANNEL.stage ? new Promise(resolve => { resolveWrite = resolve; }) : normal(channel, input));
    await act(async () => { root.render(<Opportunities detail={customer as never} canCreate selectedOpportunityId="opp-a" onSelect={oldSelect} onChange={oldChange} />); await flush(); });
    await choose('opp-a', 'quote_sent'); await click('保存阶段');
    await act(async () => { root.render(<Opportunities detail={customer as never} canCreate selectedOpportunityId={undefined} onSelect={currentSelect} onChange={currentChange} />); await flush(); });
    await act(async () => { rows[0].stage = 'quote_sent'; rows[0].version = 2; resolveWrite({ ok: true, data: structuredClone(rows[0]) }); await flush(); });
    expect(oldSelect).not.toHaveBeenCalled(); expect(currentSelect).not.toHaveBeenCalled();
    expect(oldChange).not.toHaveBeenCalled(); expect(currentChange).toHaveBeenCalledOnce();
    expect(host.querySelector('#opportunity-opp-a')!.textContent?.replace(/\s/g, '')).not.toContain('取消跟进');
  });

  it.each([false, true])('passes only the selected opportunity through the customer followup and next-task forms (cancel=%s)', async cancel => {
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel: string, input: unknown) => {
      if (channel === ONLINE.BOOTSTRAP) return { ok: true, data: { userId: identity.userId, capabilities: identity.crmCapabilities, scope: 'own', summary: { mine: 1, pool: 0 }, feedCursor: '0' } };
      if (channel === ONLINE.LIST) return { ok: true, data: { items: [customer], total: 1 } };
      if (channel === ONLINE.DETAIL || channel === ONLINE.FOLLOWUP) return { ok: true, data: customer };
      if (channel === ONLINE.TASK_LIST) return { ok: true, data: { items: [], total: 0 } };
      if (channel === ONLINE.TASK_CREATE) return { ok: true, data: { taskId: 'synthetic-task', ...(input as Record<string, unknown>) } };
      return normal(channel, input);
    });
    await act(async () => { root.render(<CustomersPage />); await flush(); });
    await act(async () => { await flush(); });
    const selectFollowup = async () => act(async () => { Array.from(document.querySelectorAll<HTMLButtonElement>('#opportunity-opp-b button')).find(button => button.textContent?.replace(/\s/g, '') === '跟进')!.click(); await flush(); });
    await selectFollowup();
    if (cancel) await act(async () => { Array.from(document.querySelectorAll<HTMLButtonElement>('#opportunity-opp-b button')).find(button => button.textContent?.replace(/\s/g, '') === '取消跟进')!.click(); await flush(); });
    const fillDrawer = async (label: string, value: string) => act(async () => {
      const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
      const prototype = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const clickDrawer = async (label: string) => act(async () => { Array.from(document.querySelectorAll('button')).find(button => button.textContent?.replace(/\s/g, '') === label)!.click(); await flush(); });
    await fillDrawer('下一步任务', '核对订舱'); await fillDrawer('下次跟进时间', '2026-10-14T09:00'); await clickDrawer('安排跟进');
    await fillDrawer('跟进记录', '联系客户确认航线'); await clickDrawer('保存跟进');
    const task = invoke.mock.calls.find(call => call[0] === ONLINE.TASK_CREATE)?.[1];
    const followup = invoke.mock.calls.find(call => call[0] === ONLINE.FOLLOWUP)?.[1];
    expect(task).toMatchObject({ customerId: 'customer-a', title: '核对订舱' });
    expect(followup).toMatchObject({ customerId: 'customer-a', note: '联系客户确认航线' });
    if (cancel) { expect(task).not.toHaveProperty('opportunityId'); expect(followup).not.toHaveProperty('opportunityId'); }
    else { expect(task).toHaveProperty('opportunityId', 'opp-b'); expect(followup).toHaveProperty('opportunityId', 'opp-b'); }
    expect(document.querySelector('#opportunity-opp-b')!.textContent?.replace(/\s/g, '')).not.toContain('取消跟进');
  });

  it('keeps the real customer drawer and edit action locked while an opportunity write is unknown', async () => {
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel: string, input: unknown) => {
      if (channel === ONLINE.BOOTSTRAP) return { ok: true, data: { userId: identity.userId, capabilities: identity.crmCapabilities, scope: 'own', summary: { mine: 1, pool: 0 }, feedCursor: '0' } };
      if (channel === ONLINE.LIST) return { ok: true, data: { items: [customer], total: 1 } };
      if (channel === ONLINE.DETAIL) return { ok: true, data: customer };
      if (channel === ONLINE.TASK_LIST) return { ok: true, data: { items: [], total: 0 } };
      if (channel === ONLINE.OPPORTUNITY_STAGE) return { ok: false, error: { code: 'UNAVAILABLE', message: 'Lost write response' } };
      return normal(channel, input);
    });
    await act(async () => { root.render(<CustomersPage />); await flush(); });
    await act(async () => { await flush(); });
    const select = document.querySelector<HTMLSelectElement>('[aria-label="商机阶段-opp-a"]')!;
    await act(async () => { select.value = 'quote_sent'; select.dispatchEvent(new Event('change', { bubbles: true })); await flush(); });
    await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="保存阶段-opp-a"]')!.click(); await flush(); });
    const edit = Array.from(document.querySelectorAll('button')).find(button => button.title === '编辑资料')!;
    expect(edit.disabled).toBe(true);
    await act(async () => { document.querySelector('.ant-drawer-mask')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); });
    expect(document.querySelector('.ant-drawer-open')).not.toBeNull();
    await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="保存阶段-opp-a"]')!.click(); await flush(); });
    const writes = invoke.mock.calls.filter(call => call[0] === ONLINE.OPPORTUNITY_STAGE).map(call => call[1]);
    expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
  });

  it('ignores a delayed list response after unmount and reports malformed success', async () => {
    let resolveList!: (value: unknown) => void;
    invoke.mockImplementation((channel: string) => channel === CHANNEL.list ? new Promise(resolve => { resolveList = resolve; }) : Promise.resolve({ ok: true, data: {} }));
    await mount();
    await act(async () => root.unmount());
    await act(async () => { resolveList({ ok: true, data: { items: 'broken', total: 1 } }); await flush(); });
    expect(host.textContent).toBe('');
    host.remove();
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    invoke.mockImplementation(async (channel: string) => channel === CHANNEL.list ? { ok: true, data: { items: 'broken', total: 1 } } : { ok: true, data: {} });
    await mount();
    expect(document.body.textContent).toContain('商机列表响应无效');
  });
});
