// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CustomersPage } from '../../src/renderer/pages/customers/CustomersPage';
import { ONLINE_CHANNELS as CHANNEL } from '../../src/shared/online-crm';
const state = vi.hoisted(() => ({ identity: { userId: 'sales-a', crmRoles: ['sales'], crmCapabilities: ['leads.create', 'leads.develop'] } as Record<string, unknown> | null }));
vi.mock('../../src/renderer/IdentityContext', () => ({ useOptionalIdentity: () => ({ identity: state.identity, refresh: vi.fn() }) }));
const customer = { customerId: 'customer-a', companyName: 'Synthetic Company A', country: 'BR', version: 1, state: 'owned', origin: 'personal', contactCount: 1, ownerUserId: 'sales-a', source: 'Manual', sourceDetail: '', customerKey: '', contacts: [{ contactId: 1, name: 'Synthetic Contact', email: 'contact@example.invalid', phone: '123', title: 'Manager', country: 'BR' }], activities: [] };
describe('R2 customer center renderer', () => {
  let root: Root; let host: HTMLDivElement; let invoke: ReturnType<typeof vi.fn>; let ticks: Array<() => void>; let capabilities: string[];
  beforeEach(() => {
    window.history.replaceState(null, '', '#/customers');
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    state.identity = { userId: 'sales-a', crmRoles: ['sales'], crmCapabilities: ['leads.create', 'leads.develop'] };
    capabilities = ['leads.create', 'leads.develop']; ticks = [];
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => { ticks.push(callback); return ticks.length; }) as typeof setInterval);
    invoke = vi.fn(async channel => ({ ok: true, data: channel === CHANNEL.BOOTSTRAP ? { userId: state.identity?.userId, capabilities, scope: 'own', summary: { mine: 1, pool: 0 }, feedCursor: '0' } : channel === CHANNEL.LIST ? { items: [customer], total: 1 } : [CHANNEL.TASK_LIST, CHANNEL.OPPORTUNITY_LIST].includes(channel) ? { items: [], total: 0 } : customer }));
    Object.defineProperty(window, 'api', { configurable: true, value: { invoke } });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
  const mount = async () => act(async () => { root.render(<CustomersPage />); await new Promise(resolve => setTimeout(resolve, 30)); });
  const click = async (text: string) => act(async () => { Array.from(document.querySelectorAll('button')).find(button => button.textContent?.replace(/\s/g, '') === text || button.title === text)!.click(); await new Promise(resolve => setTimeout(resolve, 30)); });
  const openCustomer = async () => act(async () => { host.querySelector<HTMLButtonElement>('.customer-name-link')!.click(); await new Promise(resolve => setTimeout(resolve, 30)); });
  const createCustomer = async () => act(async () => {
    const button = Array.from(host.querySelectorAll<HTMLButtonElement>('.customer-legacy-toolbar button')).find(item => /^新增(?:客户)?$/.test(item.textContent?.replace(/\s/g, '') ?? ''))!;
    expect(button).toBeDefined(); button.click(); await new Promise(resolve => setTimeout(resolve, 30));
  });
  const displayedTotal = () => Number(host.querySelector('.customer-legacy-count')!.textContent!.match(/\d+/)![0]);
  const pastePreview = async (value = '公司\t邮箱\nSynthetic\tsynthetic@example.invalid') => {
    await act(async () => { Array.from(document.querySelectorAll('[role="tab"]')).find(x => x.textContent === '粘贴数据')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { const input = document.querySelector('textarea')!; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await click('解析预览');
  };
  const moreView = async (label: string) => {
    await act(async () => { host.querySelector('[aria-label="更多客户视图"]')!.closest('.ant-select')!.querySelector('.ant-select-selector')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    await act(async () => { Array.from(document.querySelectorAll('.ant-select-item-option')).find(option => option.textContent === label)!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  };
  it('reuses the original import drawer without manual provenance and writes only through center',async()=>{
    const normal=invoke.getMockImplementation()!;
    invoke.mockImplementation(async(channel,...args)=>channel===CHANNEL.PREVIEW?{ok:true,data:{headers:['公司','邮箱'],rows:[{'公司':'Synthetic Co','邮箱':'lead@example.invalid'}],fileName:'test.csv'}}:channel===CHANNEL.IMPORT?{ok:true,data:{batchId:'batch',rows:[{status:'created'}]}}:normal(channel,...args));
    await mount();await click('导入');
    expect(document.body.textContent).toContain('上传文件');expect(document.body.textContent).toContain('粘贴数据');
    expect(document.querySelector('.ant-drawer details')?.hasAttribute('open')).toBe(false);
    expect(document.body.textContent).toContain('查看支持的列名');
    expect(document.querySelector('[aria-label="导入来源"]')).toBeNull();expect(document.querySelector('[aria-label="导入去向"]')).toBeNull();
    await act(async()=>{Array.from(document.querySelectorAll('[role="tab"]')).find(x=>x.textContent==='粘贴数据')!.dispatchEvent(new MouseEvent('click',{bubbles:true}));});
    await act(async()=>{const input=document.querySelector('textarea')!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,'公司\t邮箱\nSynthetic Co\tlead@example.invalid');input.dispatchEvent(new Event('input',{bubbles:true}));});
    await click('解析预览');
    expect(document.querySelector('.ant-drawer-footer')?.textContent).toContain('确认导入 1 条');
    await click('确认导入1条');
    expect(invoke).toHaveBeenCalledWith(CHANNEL.IMPORT,expect.objectContaining({kind:'personal',source:'desktop-import',rows:[expect.objectContaining({companyName:'Synthetic Co',email:'lead@example.invalid'})]}));
    expect(invoke.mock.calls.every(call=>String(call[0]).startsWith('online:'))).toBe(true);
  });
  it('opens an authorized deep link even when the current personal list is empty, without fetching member directory for sales', async () => {
    window.history.replaceState(null, '', '#/customers?customerId=assigned-other');
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel, ...args) => channel === CHANNEL.LIST ? { ok: true, data: { items: [], total: 0 } } : channel === CHANNEL.DETAIL ? { ok: true, data: { ...customer, customerId: 'assigned-other', origin: 'operations' } } : normal(channel, ...args));
    await mount(); expect(invoke).toHaveBeenCalledWith(CHANNEL.DETAIL, 'assigned-other'); expect(document.querySelector('.ant-drawer-open')).not.toBeNull(); expect(invoke.mock.calls.some(call => call[0] === CHANNEL.MEMBERS)).toBe(false);
  });
  it('uses center-only personal and assigned filters and exact customer detail', async () => {
    await mount();
    expect(invoke).toHaveBeenCalledWith(CHANNEL.LIST, { view: 'personal', search: '', limit: 25, offset: 0 });
    expect(host.textContent).toContain('自有线索'); expect(host.textContent).toContain('分配线索'); expect(host.textContent).not.toContain('全部客户');
    await act(async () => { Array.from(host.querySelectorAll('label')).find(label => label.textContent === '分配线索')!.click(); });
    expect(invoke).toHaveBeenCalledWith(CHANNEL.LIST, expect.objectContaining({ view: 'assigned' }));
    await openCustomer(); expect(invoke).toHaveBeenCalledWith(CHANNEL.DETAIL, 'customer-a');
    expect(document.body.textContent).toContain('contact@example.invalid'); expect(document.body.textContent).toContain('Manager');
    expect(invoke.mock.calls.every(call => String(call[0]).startsWith('online:'))).toBe(true);
    expect(invoke).not.toHaveBeenCalledWith(CHANNEL.FEED);
  });
  it('discards a prior account detail response after identity changes', async () => {
    await mount(); let finish!: (value: unknown) => void;
    invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await openCustomer(); state.identity = null; await mount();
    await act(async () => { finish({ ok: true, data: customer }); });
    expect(host.textContent).not.toContain('Synthetic Company A');
    expect(document.querySelector('.ant-drawer-open')).toBeNull();
  });
  it('polls center data, preserves offline data and clears revoked permission data', async () => {
    await mount();
    invoke.mockImplementationOnce(async () => ({ ok: false, error: { code: 'UNAVAILABLE', message: 'Synthetic offline' } }));
    await act(async () => { ticks.at(-1)!(); await new Promise(resolve => setTimeout(resolve, 30)); });
    expect(host.textContent).toContain('Synthetic offline'); expect(host.textContent).toContain('Synthetic Company A');
    capabilities = [];
    await act(async () => { ticks.at(-1)!(); await new Promise(resolve => setTimeout(resolve, 30)); });
    expect(Array.from(host.querySelectorAll('button')).some(button => /^新增(?:客户)?$/.test(button.textContent?.replace(/\s/g, '') ?? ''))).toBe(false); expect(host.textContent).not.toContain('导入');
  });
  it('creates with contacts and stable idempotency key when the same payload is retried', async () => {
    await mount(); await createCustomer();
    const fill = async (selector: string, value: string) => act(async () => { const input = document.querySelector<HTMLInputElement>(selector)!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); });
    await fill('#companyName', 'New Synthetic'); await fill('#contacts_0_email', 'new@example.invalid');
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel, ...args) => channel === CHANNEL.CREATE_CUSTOMER ? { ok: false, error: { code: 'UNAVAILABLE', message: 'Retry synthetic' } } : normal(channel, ...args));
    await click('保存'); await click('保存');
    const writes = invoke.mock.calls.filter(call => call[0] === CHANNEL.CREATE_CUSTOMER);
    expect(writes).toHaveLength(2); expect(writes[0][1]).toEqual(writes[1][1]);
    expect(writes[0][1]).toMatchObject({ companyName: 'New Synthetic', contacts: [{ email: 'new@example.invalid' }] });
  });
  it('retains unfinished import keys and payloads and does not resend completed chunks', async () => {
    await mount(); await click('导入');
    const normal = invoke.getMockImplementation()!; let imports = 0;
    const rows = Array.from({ length: 201 }, (_, index) => ({ customerKey: String(index), companyName: 'Synthetic', email: `${index}@example.invalid` }));
    invoke.mockImplementation(async (channel, ...args) => {
      if (channel === CHANNEL.PREVIEW) return { ok: true, data: { fileName: 'synthetic.csv', headers: ['customerKey', 'companyName', 'email'], rows } };
      if (channel === CHANNEL.IMPORT) { imports++; return imports === 2 ? { ok: false, error: { code: 'UNAVAILABLE', message: 'Retry chunk' } } : { ok: true, data: { batchId: `batch-${imports}`, version: 1, rows: args[0].rows.map((_: unknown, index: number) => ({ rowId: `row-${imports}-${index}`, index, status: 'created' })) } }; }
      return normal(channel, ...args);
    });
    await pastePreview();
    await click('确认导入201条');
    await click('确认导入201条');
    const writes = invoke.mock.calls.filter(call => call[0] === CHANNEL.IMPORT);
    expect(writes).toHaveLength(3); expect(writes[0][1].rows).toHaveLength(200); expect(writes[1][1]).toEqual(writes[2][1]);
    expect(writes[2][1]).toMatchObject({ kind: 'personal', source: 'desktop-import' });
  });
  it('keeps raw partial-failure evidence and repeats the exact original request without inventing a company', async () => {
    await mount(); await click('导入'); const normal = invoke.getMockImplementation()!; let writes = 0;
    invoke.mockImplementation(async (channel, ...args) => {
      if (channel === CHANNEL.PREVIEW) return { ok: true, data: { fileName: 'repair.csv', headers: ['id', 'company', 'email'], rowNumbers: [2, 4], rows: [{ id: 'one', company: 'First', email: 'first@example.invalid' }, { id: 'two', company: '', email: 'bad' }] } };
      if (channel === CHANNEL.IMPORT) { writes++; return { ok: true, data: { batchId: 'original', version: 1, rows: [{ rowId: 'ok-row', index: 0, status: 'created', customerId: 'one' }, { rowId: 'bad-row', index: 1, status: 'invalid', message: '邮箱格式无效' }] } }; }
      return normal(channel, ...args);
    });
    await pastePreview(); await click('确认导入2条');
    expect(invoke.mock.calls.find(call => call[0] === CHANNEL.IMPORT)![1].mapping).toEqual({ customerKey: 'id', companyName: 'company', email: 'email' });
    expect(document.body.textContent).toContain('部分行未导入'); await click('确认导入2条');
    const calls = invoke.mock.calls.filter(call => call[0] === CHANNEL.IMPORT); expect(calls).toHaveLength(2); expect(calls[0][1]).toEqual(calls[1][1]);
    expect(calls[0][1].rows[1]).toMatchObject({ companyName: '', email: 'bad', rawRow: { company: '', email: 'bad' } });
  });
  it('keeps the edit version fixed while polling and does not reopen a closed pending save', async () => {
    await mount(); await openCustomer(); await click('编辑资料');
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel, ...args) => channel === CHANNEL.DETAIL ? { ok: true, data: { ...customer, version: 2 } } : normal(channel, ...args));
    await act(async () => { ticks.at(-1)!(); await new Promise(resolve => setTimeout(resolve, 30)); });
    expect(invoke.mock.calls.filter(call => call[0] === CHANNEL.DETAIL)).toHaveLength(1);
    let finish!: (value: unknown) => void;
    invoke.mockImplementation(async (channel, ...args) => channel === CHANNEL.UPDATE_CUSTOMER ? new Promise(resolve => { finish = resolve; }) : normal(channel, ...args));
    await click('保存');
    expect(invoke).toHaveBeenCalledWith(CHANNEL.UPDATE_CUSTOMER, expect.objectContaining({ expectedVersion: 1 }));
    await act(async () => { document.querySelector('.ant-drawer-mask')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { finish({ ok: true, data: { ...customer, version: 3 } }); });
    expect(document.querySelector('.ant-drawer-open')).toBeNull();
  });
  it('retries the exact followup after a committed response is lost and polling advances the version', async () => {
    await mount(); await openCustomer();
    const normal = invoke.getMockImplementation()!; let committed = false;
    invoke.mockImplementation(async (channel, ...args) => {
      if (channel === CHANNEL.FOLLOWUP) { committed = true; return { ok: false, error: { code: 'UNAVAILABLE', message: 'Lost committed response' } }; }
      if (channel === CHANNEL.DETAIL && committed) return { ok: true, data: { ...customer, version: 2, stage: 'quoting' } };
      return normal(channel, ...args);
    });
    await act(async () => { const input = document.querySelector<HTMLTextAreaElement>('[aria-label="跟进记录"]')!; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Synthetic followup'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await click('保存跟进');
    await act(async () => { ticks.at(-1)!(); await new Promise(resolve => setTimeout(resolve, 30)); });
    await click('保存跟进');
    const writes = invoke.mock.calls.filter(call => call[0] === CHANNEL.FOLLOWUP);
    expect(writes).toHaveLength(2); expect(writes[0][1]).toEqual(writes[1][1]);
    expect(writes[1][1]).toMatchObject({ expectedVersion: 1, method: 'other', note: 'Synthetic followup' });
    expect(writes[1][1].stage).toBeUndefined();
  });
  it('queries operations assignments on the full center scope and resets pagination on task change', async () => {
    state.identity = { userId: 'sales-a', crmRoles: ['operations'], crmCapabilities: ['leads.import', 'leads.assign'] };
    capabilities = ['leads.import', 'leads.assign'];
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel, ...args) => channel === CHANNEL.BOOTSTRAP ? { ok: true, data: { userId: 'sales-a', capabilities, scope: 'shared', summary: { mine: 999, pool: 0 }, feedCursor: '0' } } : channel === CHANNEL.LIST ? { ok: true, data: { items: [customer], total: 76 } } : normal(channel, ...args));
    await mount(); expect(invoke).toHaveBeenCalledWith(CHANNEL.LIST, { view: 'operations', search: '', limit: 25, offset: 0 });
    expect(displayedTotal()).toBe(76); expect(host.textContent).toContain('我的线索');
    await act(async () => { host.querySelector<HTMLAnchorElement>('.ant-pagination-item-2 a')!.click(); });
    expect(invoke).toHaveBeenLastCalledWith(CHANNEL.LIST, expect.objectContaining({ offset: 25 }));
    await act(async () => { Array.from(host.querySelectorAll('label')).find(label => label.textContent === '待分配')!.click(); });
    expect(invoke).toHaveBeenCalledWith(CHANNEL.LIST, { view: 'operations', assignment: 'unassigned', search: '', limit: 25, offset: 0 });
    await act(async () => { Array.from(host.querySelectorAll('label')).find(label => label.textContent === '已分配')!.click(); });
    expect(invoke).toHaveBeenCalledWith(CHANNEL.LIST, { view: 'operations', assignment: 'assigned', search: '', limit: 25, offset: 0 });
  });
  it('keeps admin all scope and server totals without using bootstrap counts', async () => {
    capabilities = ['leads.read.all']; state.identity = { userId: 'sales-a', crmRoles: ['admin'], crmCapabilities: capabilities };
    invoke.mockImplementation(async channel => ({ ok: true, data: channel === CHANNEL.BOOTSTRAP ? { userId: 'sales-a', capabilities, scope: 'summary', summary: { mine: 99, pool: 88 }, feedCursor: '0' } : { items: [customer], total: 401 } }));
    await mount(); expect(invoke).toHaveBeenCalledWith(CHANNEL.LIST, { view: 'all', search: '', limit: 25, offset: 0 }); expect(displayedTotal()).toBe(401);
  });
  it('keeps authorized public pool previews without the retired direct claim action', async () => {
    capabilities = ['leads.claim', 'leads.develop']; state.identity = { userId: 'sales-a', crmRoles: ['sales'], crmCapabilities: capabilities };
    const pool = { ...customer, source: '', sourceDetail: '', state: 'published', ownerUserId: null, canEdit: false, canAssign: false, canFollowup: false, contacts: [], activities: [] };
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel, ...args) => channel === CHANNEL.LIST ? { ok: true, data: { items: [pool], total: 1 } } : channel === CHANNEL.DETAIL ? { ok: true, data: pool } : normal(channel, ...args));
    await mount(); await moreView('公共池');
    expect(host.querySelector('[aria-label="筛选跟进阶段"]')).toBeNull();
    await openCustomer(); expect(document.body.textContent).not.toContain('未联系');
    expect(document.body.textContent).not.toContain('领取此客户'); expect(document.body.textContent).not.toContain('分配客户');
    expect(invoke.mock.calls.some(call => ['online:claim', 'online:assign'].includes(call[0]))).toBe(false);
  });
  it('sends stage filtering to the center rather than filtering a current page', async () => {
    await mount();
    await act(async () => { host.querySelector('[aria-label="筛选跟进阶段"]')!.closest('.ant-select')!.querySelector('.ant-select-selector')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    await act(async () => { Array.from(document.querySelectorAll('.ant-select-item-option')).find(option => option.textContent === '报价中')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(invoke).toHaveBeenCalledWith(CHANNEL.LIST, { view: 'personal', search: '', limit: 25, offset: 0, stage: 'quoting' });
    // Server fixture intentionally returns a record without that stage: renderer displays authorized server result unchanged.
    expect(host.textContent).toContain('Synthetic Company A');
  });
  it('imports administrator original drawer data as operations without manual source or pool publication', async () => {
    capabilities = ['leads.import', 'leads.publish']; state.identity = { userId: 'sales-a', crmRoles: ['operations'], crmCapabilities: capabilities };
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel, ...args) => {
      if (channel === CHANNEL.BOOTSTRAP) return { ok: true, data: { userId: 'sales-a', capabilities, scope: 'shared', summary: { mine: 0, pool: 0 }, feedCursor: '0' } };
      if (channel === CHANNEL.PREVIEW) return { ok: true, data: { fileName: 'synthetic.csv', headers: ['customerKey', 'companyName', 'email'], rows: [{ customerKey: '1', companyName: 'Synthetic', email: 'public@example.invalid' }, { customerKey: 'bad', companyName: 'Bad', email: 'bad' }] } };
      if (channel === CHANNEL.IMPORT) return { ok: true, data: { batchId: 'operations-batch', version: 1, rows: [{ rowId: 'row-valid', index: 0, status: 'created' }, { rowId: 'row-duplicate', index: 1, status: 'duplicate' }] } };
      if (channel === CHANNEL.PUBLISH) return { ok: false, error: { code: 'UNAVAILABLE', message: 'Lost publish response' } };
      return normal(channel, ...args);
    });
    await mount(); await click('导入');
    expect(document.querySelector('[aria-label="导入来源"]')).toBeNull();
    expect(document.querySelector('[aria-label="导入去向"]')).toBeNull();
    await pastePreview(); await click('确认导入2条');
    const imported = invoke.mock.calls.find(call => call[0] === CHANNEL.IMPORT)![1]; expect(imported.kind).toBe('operations'); expect(imported.source).toBe('desktop-import');
    expect(invoke.mock.calls.some(call => call[0] === CHANNEL.PUBLISH)).toBe(false);
  });
  it('lets operations find personally created customers without reclassifying ownership', async () => {
    capabilities = ['leads.import', 'leads.create', 'leads.develop']; state.identity = { userId: 'sales-a', crmRoles: ['operations'], crmCapabilities: capabilities };
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel, ...args) => channel === CHANNEL.BOOTSTRAP ? { ok: true, data: { userId: 'sales-a', capabilities, scope: 'shared', summary: { mine: 0, pool: 0 }, feedCursor: '0' } } : normal(channel, ...args));
    await mount(); expect(host.textContent).toContain('我的线索'); await moreView('个人客户'); await moreView('分配给我'); await act(async () => { Array.from(host.querySelectorAll('label')).find(label => label.textContent === '我的线索')!.click(); });
    await createCustomer();
    for (const [selector, value] of [['#companyName', 'Personal Synthetic'], ['#contacts_0_email', 'personal@example.invalid']]) await act(async () => { const input = document.querySelector<HTMLInputElement>(selector)!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await click('保存'); expect(invoke).toHaveBeenCalledWith(CHANNEL.CREATE_CUSTOMER, expect.objectContaining({ companyName: 'Personal Synthetic' }));
    await act(async () => { document.querySelector('.ant-drawer-mask')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await moreView('个人客户');
    expect(invoke).toHaveBeenCalledWith(CHANNEL.LIST, { view: 'personal', search: '', limit: 25, offset: 0 });
  });
  it('keeps an operations account restricted to own scope on personal customer views', async () => {
    state.identity = { userId: 'sales-a', crmRoles: ['operations'], crmCapabilities: ['leads.import', 'leads.create', 'leads.develop', 'leads.read.all'] };
    capabilities = ['leads.import', 'leads.create', 'leads.develop', 'leads.read.all'];
    await mount();
    expect(invoke).toHaveBeenCalledWith(CHANNEL.LIST, expect.objectContaining({ view: 'personal' }));
    expect(host.textContent).toContain('自有线索'); expect(host.textContent).not.toContain('我的线索'); expect(host.textContent).not.toContain('全部客户');
    await act(async () => { ticks.at(-1)!(); await new Promise(resolve => setTimeout(resolve, 30)); });
    expect(invoke.mock.calls.filter(call => call[0] === CHANNEL.LIST).every(call => call[1].view === 'personal')).toBe(true);
    expect(host.textContent).toContain('Synthetic Company A');
  });
});
