// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CustomersPage } from '../../src/renderer/pages/customers/CustomersPage';
import { ONLINE_CHANNELS as CHANNEL, ONLINE_LIMITS } from '../../src/shared/online-crm';
const state = vi.hoisted(() => ({ identity: { userId: 'sales-a', crmRoles: ['sales'], crmCapabilities: ['leads.develop'] } as Record<string, unknown> | null }));
vi.mock('../../src/renderer/IdentityContext', () => ({ useOptionalIdentity: () => ({ identity: state.identity, refresh: vi.fn() }) }));
const fixture = { customerId: 'customer-a', companyName: 'B2 Synthetic', version: 1, stage: 'cold', state: 'owned', origin: 'personal', contactCount: 2, hasContacted: true, ownerUserId: 'sales-a', source: 'Manual', sourceDetail: '', customerKey: '', contacts: [{ contactId: 11, name: 'First', email: '', touchStatus: 'uncontacted' }, { contactId: 12, name: 'Second', email: 'second@example.invalid', touchStatus: 'replied' }], activities: [] };
describe('B2 customer followup renderer', () => {
  let root: Root; let host: HTMLDivElement; let invoke: ReturnType<typeof vi.fn>; let ticks: Array<() => void>; let customer: typeof fixture;
  beforeEach(() => {
    window.history.replaceState(null, '', '#/customers?customerId=customer-a');
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    state.identity = { userId: 'sales-a', crmRoles: ['sales'], crmCapabilities: ['leads.develop'] }; customer = structuredClone(fixture); ticks = [];
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, delay: number) => { if (delay === ONLINE_LIMITS.pollMs) ticks.push(callback); return ticks.length; }) as typeof setInterval);
    invoke = vi.fn(async channel => ({ ok: true, data: channel === CHANNEL.BOOTSTRAP ? { userId: 'sales-a', capabilities: ['leads.develop'], scope: 'own', summary: { mine: 1, pool: 0 }, feedCursor: '0' } : channel === CHANNEL.LIST ? { items: [customer], total: 1 } : customer }));
    Object.defineProperty(window, 'api', { configurable: true, value: { invoke } });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
  const flush = () => new Promise(resolve => setTimeout(resolve, 30));
  const mount = async () => act(async () => { root.render(<CustomersPage />); await flush(); });
  const click = async (label: string) => act(async () => { Array.from(document.querySelectorAll('button')).find(button => button.textContent?.replace(/\s/g, '') === label)!.click(); await flush(); });
  const fill = async (label: string, value: string) => act(async () => {
    const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
    const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const choose = async (label: string, option: string) => {
    await act(async () => { document.querySelector(`[aria-label="${label}"]`)!.closest('.ant-select')!.querySelector('.ant-select-selector')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    await act(async () => { Array.from(document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')).find(item => item.textContent === option)!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  };
  const writes = () => invoke.mock.calls.filter(call => call[0] === CHANNEL.FOLLOWUP).map(call => call[1]);
  const poll = async () => act(async () => { ticks[0]!(); await flush(); });

  it('allows ordinary users their own board, with six original stages and no cold column', async () => {
    window.history.replaceState(null, '', '#/customers?view=board'); await mount();
    expect(document.querySelector('.customer-classic-board')).not.toBeNull();
    expect(document.querySelectorAll('.customer-classic-stage')).toHaveLength(6);
    expect(document.querySelector('.customer-classic-board')!.textContent).not.toContain('未联系');
    expect(document.querySelector('.customer-classic-board')!.textContent).toContain('B2 Synthetic');
    expect(invoke.mock.calls.filter(call=>call[0]===CHANNEL.LIST).some(call=>call[1].followupOnly===true)).toBe(true);
  });
  it('excludes untouched customers even when they have a non-cold relationship stage', async () => {
    customer.stage='quoting';customer.hasContacted=false;
    window.history.replaceState(null, '', '#/customers?view=board');await mount();
    expect(document.querySelector('.customer-classic-board')!.textContent).not.toContain('B2 Synthetic');
    await act(async()=>{window.history.replaceState(null,'','#/customers?view=table');window.dispatchEvent(new HashChangeEvent('hashchange'));await flush();});
    expect(document.querySelector('.customer-legacy-table')!.textContent).toContain('B2 Synthetic');
    expect(document.querySelector<HTMLButtonElement>('[title="在跟进看板中查看"]')!.disabled).toBe(true);
  });
  it('opens the original tabbed customer detail layout on table-row double click', async () => {
    window.history.replaceState(null, '', '#/customers');await mount();
    await act(async()=>{document.querySelector('.customer-legacy-table .ant-table-row')!.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));await flush();});
    expect(document.querySelector('.customer-classic-contact-detail .contact-detail-tabs')).not.toBeNull();
    expect(document.querySelector('.customer-contact-profile')!.textContent).toContain('联系方式');
    expect(document.querySelector('.customer-contact-profile')!.textContent).toContain('电话');
    expect(document.querySelector('.customer-contact-profile')!.textContent).toContain('系统信息');
    expect(document.querySelector('.customer-classic-contact-detail .customer-tasks')).not.toBeNull();
    expect(document.querySelector('.customer-classic-contact-detail .customer-opportunities')).not.toBeNull();
  });
  it('records company-level telephone followup for zero contacts without changing customer stage', async () => {
    customer.contacts = []; customer.contactCount = 0; await mount(); await choose('联系方法', '电话'); await fill('跟进记录', 'Company call'); await click('保存跟进');
    expect(writes()[0]).toMatchObject({ customerId: 'customer-a', expectedVersion: 1, note: 'Company call', method: 'phone' });
    expect(writes()[0].stage).toBeUndefined(); expect(writes()[0].contactId).toBeUndefined(); expect(writes()[0].contactStatus).toBeUndefined();
  });
  it('submits an explicit local historical time, selected contact, touch result and optional cold stage', async () => {
    await mount(); await choose('联系方法', '拜访'); await fill('发生时间', '2026-01-02T09:35'); await choose('跟进联系人', 'Second'); await choose('触达结果', '已触达'); await choose('跟进阶段', '未联系'); await fill('跟进记录', 'Historical visit'); await click('保存跟进');
    expect(writes()[0]).toMatchObject({ method: 'visit', occurredAt: new Date('2026-01-02T09:35').toISOString(), contactId: 12, contactStatus: 'contacted', stage: 'cold' });
    expect(document.body.textContent).toContain('未触达'); expect(document.body.textContent).toContain('已回复');
  });
  it('clears the touch result when switching to note while retaining an optional contact', async () => {
    await mount(); await choose('跟进联系人', 'First'); await choose('触达结果', '已回复'); await choose('联系方法', '备注');
    expect(document.querySelector('[aria-label="触达结果"]')!.closest('.ant-select')!.classList.contains('ant-select-disabled')).toBe(true);
    await fill('跟进记录', 'Internal note'); await click('保存跟进'); expect(writes()[0]).toMatchObject({ method: 'note', contactId: 11 }); expect(writes()[0].contactStatus).toBeUndefined();
  });
  it('freezes all draft fields and version across a lost response and polling, then retries the whole input', async () => {
    await mount(); await choose('联系方法', '邮件'); await fill('发生时间', '2026-01-02T09:35'); await choose('跟进联系人', 'Second'); await choose('触达结果', '已回复'); await choose('跟进阶段', '报价中'); await fill('跟进记录', 'Lost response');
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel, ...args) => channel === CHANNEL.FOLLOWUP ? { ok: false, error: { code: 'UNAVAILABLE', message: 'Unknown result' } } : normal(channel, ...args));
    await click('保存跟进'); customer.version = 2; await poll();
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="跟进记录"]')!.disabled).toBe(true);
    expect(document.querySelector<HTMLInputElement>('[aria-label="发生时间"]')!.disabled).toBe(true);
    for (const label of ['联系方法', '跟进联系人', '触达结果', '跟进阶段']) expect(document.querySelector(`[aria-label="${label}"]`)!.closest('.ant-select')!.classList.contains('ant-select-disabled')).toBe(true);
    await click('保存跟进'); expect(writes()).toHaveLength(2); expect(writes()[1]).toEqual(writes()[0]); expect(writes()[1].expectedVersion).toBe(1);
  });
  it('freezes version on method edits before a note exists and allows correcting an explicit rejection', async () => {
    await mount(); await choose('联系方法', '电话'); customer.version = 2; await poll(); await fill('跟进记录', 'Old draft');
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel, ...args) => channel === CHANNEL.FOLLOWUP ? { ok: false, error: { code: 'CONFLICT', message: 'Version rejected' } } : normal(channel, ...args));
    await click('保存跟进'); expect(writes()[0].expectedVersion).toBe(1); expect(document.querySelector<HTMLTextAreaElement>('[aria-label="跟进记录"]')!.disabled).toBe(false);
    await fill('跟进记录', 'Corrected draft'); await choose('联系方法', '拜访'); await click('保存跟进');
    expect(writes()[1]).toMatchObject({ expectedVersion: 2, note: 'Corrected draft', method: 'visit' }); expect(writes()[1].idempotencyKey).not.toBe(writes()[0].idempotencyKey);
  });
  it('renders activity occurrence, actor, contact and historical recording with safe legacy fallback', async () => {
    Object.assign(customer, { stageNeedsReview: true, activities: [{ id: 'historical', actorId: 'sales-a', actorName: 'Recorder', note: 'Visit', stage: null, method: 'visit', occurredAt: '2026-01-02T01:35:00Z', recordedAt: '2026-01-03T01:35:00Z', createdAt: '2026-01-03T01:35:00Z', contactId: 12, contactName: 'Second' }, { id: 'legacy', actorId: 'sales-a', note: 'Old record', stage: 'quoting', createdAt: '2026-01-01T01:35:00Z' }] });
    await mount(); expect(document.body.textContent).toContain('待核对'); expect(document.body.textContent).toContain('历史记录'); expect(document.body.textContent).toContain('Recorder'); expect(document.body.textContent).toContain('录入于');
    const activity = Array.from(document.querySelectorAll('.ant-list-item')).find(item => item.textContent?.includes('Visit'))!;
    expect(activity.textContent).toContain('Second'); expect(activity.textContent).toContain(new Date('2026-01-02T01:35:00Z').toLocaleString('zh-CN'));
  });
  it('keeps a rejected draft locked until the center refresh finishes', async () => {
    await mount(); await fill('跟进记录', 'Rejected draft'); const normal = invoke.getMockImplementation()!; let refresh!: (value: unknown) => void;
    invoke.mockImplementation(async (channel, ...args) => channel === CHANNEL.FOLLOWUP ? { ok: false, error: { code: 'CONFLICT', message: 'Version rejected' } } : channel === CHANNEL.DETAIL ? new Promise(resolve => { refresh = resolve; }) : normal(channel, ...args));
    await click('保存跟进'); expect(document.querySelector<HTMLTextAreaElement>('[aria-label="跟进记录"]')!.disabled).toBe(true);
    await act(async () => { refresh({ ok: true, data: { ...customer, version: 3 } }); await flush(); });
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="跟进记录"]')!.disabled).toBe(false);
    await fill('跟进记录', 'Corrected'); await click('保存跟进'); expect(writes()[1]).toMatchObject({ expectedVersion: 3, note: 'Corrected' });
    await act(async () => { refresh({ ok: true, data: { ...customer, version: 3 } }); await flush(); });
  });
  it.each(['pending', 'committed'])('does not open stale polling detail when a save becomes %s during a delayed list read', async phase => {
    await mount(); await fill('跟进记录', 'New activity'); const normal = invoke.getMockImplementation()!;
    let listResult!: (value: unknown) => void; let saveResult!: (value: unknown) => void; let delayedList = true;
    const stale = structuredClone(customer); const saved = { ...customer, version: 2, companyName: 'Saved customer' };
    invoke.mockImplementation(async (channel, ...args) => {
      if (channel === CHANNEL.LIST && delayedList) { delayedList = false; return new Promise(resolve => { listResult = resolve; }); }
      if (channel === CHANNEL.FOLLOWUP) return new Promise(resolve => { saveResult = resolve; });
      if (channel === CHANNEL.DETAIL) return { ok: true, data: stale };
      return normal(channel, ...args);
    });
    await poll(); await act(async () => { await flush(); }); expect(listResult).toBeTypeOf('function'); await click('保存跟进');
    if (phase === 'committed') await act(async () => { saveResult({ ok: true, data: saved }); await flush(); });
    await act(async () => { listResult({ ok: true, data: { items: [stale], total: 1 } }); await flush(); });
    expect(invoke.mock.calls.filter(call => call[0] === CHANNEL.DETAIL)).toHaveLength(1);
    if (phase === 'pending') await act(async () => { saveResult({ ok: true, data: saved }); await flush(); });
    expect(document.querySelector('[aria-label="客户公司"]')!.textContent).toBe('Saved customer');
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="跟进记录"]')!.value).toBe('');
  });
  it('discards an already pending polling detail after a successful save', async () => {
    await mount(); await fill('跟进记录', 'New activity'); const normal = invoke.getMockImplementation()!;
    let detailResult!: (value: unknown) => void; const stale = structuredClone(customer);
    invoke.mockImplementation(async (channel, ...args) => channel === CHANNEL.DETAIL ? new Promise(resolve => { detailResult = resolve; }) : channel === CHANNEL.FOLLOWUP ? { ok: true, data: { ...customer, version: 2, companyName: 'Saved customer' } } : normal(channel, ...args));
    await poll(); await click('保存跟进'); await act(async () => { detailResult({ ok: true, data: stale }); await flush(); });
    expect(document.querySelector('[aria-label="客户公司"]')!.textContent).toBe('Saved customer');
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="跟进记录"]')!.value).toBe('');
  });
  it('resets selected contact and draft fields on customer and account change', async () => {
    await mount(); await choose('跟进联系人', 'Second'); await choose('触达结果', '已回复'); await fill('跟进记录', 'Old customer');
    customer = { ...structuredClone(fixture), customerId: 'customer-b', contacts: [] };
    await act(async () => { window.history.replaceState(null, '', '#/customers?customerId=customer-b'); window.dispatchEvent(new Event('hashchange')); await flush(); });
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="跟进记录"]')!.value).toBe('');
    await fill('跟进记录', 'New company'); await click('保存跟进'); expect(writes()[0].customerId).toBe('customer-b'); expect(writes()[0].contactId).toBeUndefined();
    state.identity = null; await mount(); expect(document.querySelector('[aria-label="跟进记录"]')).toBeNull();
  });
});
