// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LegacyCustomersPage } from '../../src/renderer/pages/customers/LegacyCustomersPage';
import { ONLINE_CHANNELS } from '../../src/shared/online-crm';
vi.mock('../../src/renderer/IdentityContext', () => ({ useIdentity: () => ({ identity: { userId: 'fixture', crmRoles: ['sales'] }, baseUrl: 'http://fixture.invalid', status: 'authenticated' }) }));
vi.mock('@tanstack/react-router', () => ({ useRouterState: () => ({ pathname: '/customers', searchStr: '' }) }));
const fixture = { contactId: 1, customerId: '12345678-1234-1234-1234-123456789abc', customerVersion: 1, companyId: 1, companyName: 'Preview Company', email: 'alice@example.invalid', firstName: 'Alice', lastName: null, title: 'Manager', phone: null, linkedinUrl: null, country: 'Brazil', clientType: 'agent', language: 'en', stage: 'cold', status: 'reached', tags: [], extra: {}, touchStatus: 'contacted', assignee: '', source: 'fixture', sourceDetail: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ownerUserId: 'fixture', ownerName: 'Fixture', origin: 'personal', state: 'owned' };
describe('formal customer page reuses original presentation with center identity', () => {
  let root: Root; let host: HTMLDivElement; let queryClient: QueryClient; let invoke: ReturnType<typeof vi.fn>;
  const flush = () => new Promise(resolve => setTimeout(resolve, 50));
  beforeEach(() => { window.location.hash = '#/customers'; (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) }); invoke = vi.fn(async (channel, input) => channel === ONLINE_CHANNELS.CONTACT_DETAIL ? { ok: true, data: { contact: fixture, company: { companyId: 1, name: fixture.companyName, domain: null, backcheckData: null }, activities: [], canEdit: true, canFollowup: true, canAssign: false, mailAvailable: false } } : channel === ONLINE_CHANNELS.CONTACT_GROUPS ? { ok: true, data: { items: [{ key: 'fixture-batch', label: 'Fixture batch', count: 51 }], total: 1 } } : { ok: true, data: { items: [fixture], total: (input as { limit?: number } | undefined)?.limit === 100 ? 1 : 51 } }); Object.defineProperty(window, 'api', { configurable: true, value: { invoke } }); queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
  afterEach(async () => { await act(async () => root.unmount()); queryClient.clear(); host.remove(); localStorage.removeItem('contacts-cols'); localStorage.removeItem('contacts-cols-lead-fields'); });
  const mount = async () => { await act(async () => { root.render(<QueryClientProvider client={queryClient}><LegacyCustomersPage /></QueryClientProvider>); }); await act(flush); };
  const showTable = async () => { await act(async () => { Array.from(host.querySelectorAll('.ant-segmented-item')).find(item => item.textContent === '联系人')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); await vi.waitFor(() => expect(host.querySelector('.contact-group-card')).not.toBeNull(), { timeout: 2000 }); await act(async () => { host.querySelector<HTMLButtonElement>('.contact-group-card')!.click(); }); await act(() => new Promise(resolve => setTimeout(resolve, 250))); };
  const openTable = async () => { await showTable(); await vi.waitFor(() => expect(host.querySelector('.ant-table-row')).not.toBeNull(), { timeout: 2000 }); };
  it('shows contact groups first and opens the existing table as the second level', async () => {
    await mount();
    await act(async () => { Array.from(host.querySelectorAll('.ant-segmented-item')).find(item => item.textContent === '联系人')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await vi.waitFor(() => expect(host.querySelector('.contact-group-card')).not.toBeNull(), { timeout: 2000 });
    expect(host.textContent).toContain('Fixture batch');
    expect(host.querySelector('.contact-group-card')?.textContent).toContain('51');
    await act(async () => { host.querySelector<HTMLButtonElement>('.contact-group-card')!.click(); });
    await vi.waitFor(() => expect(host.querySelector('.ant-table-row')).not.toBeNull(), { timeout: 2000 });
    expect(host.querySelector('.contact-group-context')?.textContent).toContain('Fixture batch');
  });
  it('reads center IPC with original columns, pagination, selection, detail and compact origin filter', async () => {
    await mount(); await openTable(); expect(host.textContent).toContain('Preview Company'); expect(host.textContent).toContain('Alice'); expect(host.textContent).toContain('Manager');
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.CONTACT_LIST, expect.objectContaining({ search: '', scope: 'all', groupDimension: 'batch', groupKey: 'fixture-batch', limit: 50, offset: 0 }));
    await act(async () => { host.querySelector('.ant-pagination-item-2')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); });
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.CONTACT_LIST, expect.objectContaining({ search: '', scope: 'all', groupDimension: 'batch', groupKey: 'fixture-batch', limit: 50, offset: 50 }));
    await act(async () => { host.querySelector('.ant-table-row')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    await act(flush);
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.CONTACT_DETAIL, { contactId: 1, customerId: fixture.customerId });
    expect(document.body.textContent).toContain('基本信息');
    expect(host.querySelector('.ant-table-selection-column')).toBeTruthy();
    expect(host.querySelector('[aria-label="线索来源"]')).toBeNull();
    for (const label of ['联系人姓名','公司名','客户类型','WhatsApp','一级来源','二级来源']) expect(host.querySelector('.ant-table-thead')!.textContent).toContain(label);
    for (const label of ['发送阶段','客户阶段','一级来源','二级来源','业务类型','网站','导入批次来源']) expect(document.body.textContent).toContain(label);
    expect(host.textContent).not.toContain('隔离预览');
    expect(invoke.mock.calls.every(call => String(call[0]).startsWith('online:') || call[0] === 'system:getConfig')).toBe(true);
  });
  it('shows center errors rather than treating an unavailable endpoint as a successful empty list', async () => {
    invoke.mockResolvedValue({ ok: false, error: { code: 'UNAVAILABLE', message: '中心暂不可用' } }); await mount(); await act(async () => { Array.from(host.querySelectorAll('.ant-segmented-item')).find(item => item.textContent === '联系人')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull(), { timeout: 2000 });
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('中心暂不可用');
  });
  it.each([false,true])('migrates old source preferences once and preserves explicit batch-source choices (new=%s)',async(current)=>{
    localStorage.setItem(current ? 'contacts-cols-lead-fields' : 'contacts-cols',JSON.stringify(['name','source']));
    await mount(); await openTable();
    const headers=host.querySelector('.ant-table-thead')!.textContent!;
    expect(headers.includes('一级来源')).toBe(!current);
    expect(headers.includes('二级来源')).toBe(!current);
    expect(headers.includes('导入批次来源')).toBe(current);
  });
  it('opens the existing add drawer with separate company fields, phone/WhatsApp and two contact source levels', async () => {
    await mount(); await openTable();
    await act(async()=>{host.querySelector<HTMLButtonElement>('button[aria-label="更多操作"]')!.click();}); await act(flush);
    await act(async()=>{Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='新增')!.click();}); await act(flush);
    const drawer=document.querySelector('.ant-drawer-open')!;
    for(const name of ['companyName','country','customerType','businessType','website','firstName','lastName','title','phone','whatsapp','email','sourceLevel1','sourceLevel2','stage']) expect(drawer.querySelector(`[id="${name}"]`),name).toBeTruthy();
    expect(drawer.querySelector('[id="clientType"]')).toBeNull();
    expect(drawer.querySelector('label[for="email"]')!.classList.contains('ant-form-item-required')).toBe(false);
    expect(drawer.textContent).toContain('公司资料');
    expect(drawer.textContent).toContain('联系人与线索来源');
  });
  it('opens a prefilled add drawer from inbox and saves only through center import', async () => {
    const fallback = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel, input) => channel === ONLINE_CHANNELS.IMPORT
      ? { ok: true, data: { batchId: 'fixture-batch', version: 1, rows: [{ status: 'created', customerId: fixture.customerId }] } }
      : fallback(channel, input));
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    window.location.hash = '#/customers?view=table&add=1&inbox=91&email=lead%40example.invalid&company=Acme&firstName=Ana&lastName=Silva';
    await mount();
    await vi.waitFor(() => expect(document.querySelector('.ant-drawer-open')).not.toBeNull(), { timeout: 2000 });
    const drawer = document.querySelector('.ant-drawer-open')!;
    expect(drawer.querySelector<HTMLInputElement>('#email')?.value).toBe('lead@example.invalid');
    expect(drawer.querySelector<HTMLInputElement>('#companyName')?.value).toBe('Acme');
    expect(drawer.querySelector<HTMLInputElement>('#firstName')?.value).toBe('Ana');
    expect(drawer.querySelector<HTMLInputElement>('#lastName')?.value).toBe('Silva');
    await act(async () => { drawer.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); await flush(); });
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.IMPORT, expect.objectContaining({
      source: 'manual', sourceDetail: '', companyMatching: true,
      rows: [expect.objectContaining({ email: 'lead@example.invalid', companyName: 'Acme', firstName: 'Ana', lastName: 'Silva' })],
    }));
    expect(invoke.mock.calls.every(call => String(call[0]).startsWith('online:') || call[0] === 'system:getConfig')).toBe(true);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['contacts'] });
    expect(window.location.hash).toBe('#/inbox?detail=91');
  });
  it('refreshes an inactive company list before returning from inbox contact creation', async () => {
    let companyCount = 0;
    const fallback = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel, input) => {
      if (channel === ONLINE_CHANNELS.COMPANY_LIST) return { ok: true, data: { items: companyCount ? [{ companyId: 2, name: 'Acme', domain: null, industry: null, country: null, size: null, createdAt: fixture.createdAt, updatedAt: fixture.updatedAt, contactCount: companyCount, canDelete: false, revision: 'company-revision' }] : [], total: companyCount ? 1 : 0 } };
      if (channel === ONLINE_CHANNELS.IMPORT) { companyCount = 1; return { ok: true, data: { batchId: 'fixture-batch', version: 1, rows: [{ status: 'created', customerId: fixture.customerId }] } }; }
      return fallback(channel, input);
    });
    window.location.hash = '#/customers?view=company';
    await mount();
    await vi.waitFor(() => expect(invoke.mock.calls.some(call => call[0] === ONLINE_CHANNELS.COMPANY_LIST)).toBe(true));
    const initialCompanyCalls = invoke.mock.calls.filter(call => call[0] === ONLINE_CHANNELS.COMPANY_LIST).length;
    window.location.hash = '#/customers?view=table&add=1&inbox=91&email=lead%40acme.invalid&company=Acme';
    await act(async () => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
    await vi.waitFor(() => expect(document.querySelector('.ant-drawer-open')).not.toBeNull(), { timeout: 2000 });
    await act(async () => { document.querySelector<HTMLButtonElement>('.ant-drawer-open button[type="submit"]')!.click(); await flush(); });
    await vi.waitFor(() => expect(invoke.mock.calls.filter(call => call[0] === ONLINE_CHANNELS.COMPANY_LIST).length).toBeGreaterThan(initialCompanyCalls));
    window.location.hash = '#/customers?view=company';
    await act(async () => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
    await vi.waitFor(() => expect(host.textContent).toContain('Acme'));
    expect(host.textContent).toContain('1人');
  });
  it('keeps original board and company presentation while all queries remain center scoped', async () => {
    invoke.mockImplementation(async (channel, input) => channel === ONLINE_CHANNELS.COMPANY_LIST ? {ok:true,data:{items:[{companyId:1,name:fixture.companyName,domain:null,industry:null,country:null,size:null,createdAt:fixture.createdAt,updatedAt:fixture.updatedAt,contactCount:1,canDelete:false,revision:'revision'}],total:1}} : channel === 'system:getConfig' ? {success:true,data:{crm:{}}} : channel === ONLINE_CHANNELS.CONTACT_DETAIL ? { ok: true, data: { contact: fixture, company: { companyId: 1, name: fixture.companyName, domain: null, backcheckData: null }, activities: [], canEdit: true, canFollowup: true, canAssign: false, mailAvailable: false } } : { ok: true, data: { items: [fixture], total: (input as { limit?: number } | undefined)?.limit === 100 ? 1 : 51 } });
    await mount();
    await act(async () => { Array.from(host.querySelectorAll('.ant-segmented-item')).find(item => item.textContent === '跟进看板')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); await act(flush);
    expect(host.textContent).toContain('全部国家'); expect(host.textContent).toContain('触达中'); expect(host.textContent).toContain('Alice');
    expect(Array.from(host.querySelectorAll('button')).find(button => button.textContent === '运价更新')?.disabled).toBe(false);
    await act(async () => { Array.from(host.querySelectorAll('.ant-segmented-item')).find(item => item.textContent === '公司')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); await act(flush);
    expect(host.querySelector('[style*="width: 280px"]')).toBeTruthy(); expect(host.textContent).toContain('Preview Company'); expect(host.textContent).toContain('发 —');
    expect(invoke.mock.calls.every(call => String(call[0]).startsWith('online:') || call[0] === 'system:getConfig')).toBe(true);
  });
});
