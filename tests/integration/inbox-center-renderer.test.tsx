// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { message } from 'antd';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { InboxList } from '../../src/renderer/pages/inbox/InboxList';
import { CenterContactDetail } from '../../src/renderer/pages/customers/CenterContactDetail';
import { ONLINE_CHANNELS } from '../../src/shared/online-crm';
vi.mock('../../src/renderer/IdentityContext', () => ({ useOptionalIdentity: () => ({ identity: { userId: 'fixture' }, baseUrl: 'http://fixture.invalid', status: 'authenticated' }), useIdentity: () => ({ identity: { userId: 'fixture' }, baseUrl: 'http://fixture.invalid', status: 'authenticated' }) }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn(), useRouterState: () => ({ pathname: '/inbox', searchStr: '' }) }));
vi.mock('../../src/renderer/components/CompanyBackcheck', () => ({ COMPANY_BACKCHECK_UI_ENABLED: false, CompanyBackcheck: () => <div /> }));
const reference = { contactId: 7, customerId: 'customer-center' };
const contact = { ...reference, contactVersion: 4, customerVersion: 1, companyId: 8, companyName: 'Center Company', email: 'buyer@buyer.example', firstName: 'Buyer', lastName: null, tags: [], extra: {}, status: 'replied', touchStatus: 'replied', stage: 'cold' };
const detail = { contact, company: { companyId: 8, name: 'Center Company', domain: null, backcheckData: null }, activities: [{ id: 'duplicate-activity', actorName: 'fixture', note: 'Duplicate mail activity', occurredAt: '2026-10-14T00:00:00Z' }, { id: 'standalone-note', actorName: 'fixture', note: 'Independent note', occurredAt: '2026-10-13T00:00:00Z' }], canEdit: true, canFollowup: true, canAssign: false, mailAvailable: true, mailEvents: [{ ...reference, eventId: 'mail-event', activityId: 'duplicate-activity', kind: 'replied', direction: 'inbound', occurredAt: '2026-10-14T00:00:00Z', fromEmail: contact.email, toEmails: ['sales@example.test'], ccEmails: [], subject: 'Real mail subject', preview: 'Real mail preview' }] };
describe('center contact mailbox renderer boundary', () => {
  let root: Root; let host: HTMLDivElement; let qc: QueryClient; let invoke: ReturnType<typeof vi.fn>;
  let eventHandlers: Map<string, (payload: unknown) => void>;
  const flush = () => new Promise(resolve => setTimeout(resolve, 60));
  beforeEach(() => {
    window.location.hash = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
    invoke = vi.fn(async channel => {
      if (channel === ONLINE_CHANNELS.CONTACT_DETAIL || channel === ONLINE_CHANNELS.CONTACT_UPDATE || channel === ONLINE_CHANNELS.CONTACT_FOLLOWUP) return { ok: true, data: detail };
      if (channel === 'inbox:classify') return {success:true};
      if (channel === 'inbox:list') return { success: true, data: [{ id: 1, fromEmail: contact.email, fromName: 'Buyer', subject: 'Fixture mail', bodyPreview: 'Fixture', classification: 'replied', matchedContactId: null, isRead: 1, receivedAt: '2026-10-14T00:00:00Z', _centerContact: reference, _contactStatus: 'replied' }] };
      if (channel === 'contacts:listForMatch') return { success: true, data: [{ id: 7, email: contact.email, companyName: contact.companyName, contactVersion: contact.contactVersion, canDelete: true, centerReference: reference }] };
      if (channel === 'inbox:getBody') return { success: true, data: '<p>Fixture message</p>' };
      if (channel === 'inbox:bounceMatchStats') return { success: true, data: { count: 0, emails: [] } };
      return { success: true, data: [] };
    });
    eventHandlers = new Map();
    Object.defineProperty(window, 'api', { configurable: true, value: {
      invoke,
      on: (channel: string, handler: (payload: unknown) => void) => {
        eventHandlers.set(channel, handler);
        return () => eventHandlers.delete(channel);
      },
    } });
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); qc.clear(); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  async function mount(node: React.ReactNode) { await act(async () => root.render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)); await act(flush); }
  it('hides company backcheck while keeping offline contact history guidance', async () => {
    invoke.mockResolvedValue({ ok: true, data: { ...detail, supplementAvailable: false, activities: [], mailEvents: [] } });
    await mount(<CenterContactDetail reference={reference} onClose={() => {}} />);
    const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
    expect(tabs.map(tab => tab.textContent)).toEqual(['基本信息', '往来记录']);
    expect(document.body.textContent).not.toContain('公司背调');
    await act(async () => { tabs.find(tab => tab.textContent === '往来记录')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); });
    expect(document.body.textContent).toContain('联网后加载往来记录');
    expect(document.body.textContent).not.toContain('邮件往来暂未接入');
  });
  it('renders the board contact card above the board with a blocking layer', async () => {
    await mount(<CenterContactDetail reference={reference} onClose={() => {}} variant="board" />);
    const layer = document.querySelector('.customer-classic-floating-detail');
    expect(layer).not.toBeNull();
    expect(layer!.querySelector('.ant-drawer-mask')).not.toBeNull();
  });
  it('recognizes center matches and opens the explicit center route', async () => {
    await mount(<InboxList />);
    expect(host.textContent).toContain('已匹配');
    await act(async () => { Array.from(host.querySelectorAll('span')).find(el => el.textContent === 'Fixture mail')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); });
    await act(flush);
    await act(async () => { Array.from(host.querySelectorAll('button')).find(el => el.textContent === 'Center Company')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(window.location.hash).toBe('#/customers?view=table&centerContact=7&centerCustomer=customer-center');
    expect(invoke.mock.calls.some(call => call[0] === 'contacts:upsert' || call[0] === 'contacts:delete')).toBe(false);
  });
  it('routes an unmatched sender to prefilled center contact creation', async () => {
    const delegate = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel, input) => channel === 'contacts:listForMatch'
      ? { success: true, data: [] }
      : delegate(channel, input));
    await mount(<InboxList />);
    await act(async () => { Array.from(host.querySelectorAll('span')).find(el => el.textContent === 'Fixture mail')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); });
    const add = Array.from(host.querySelectorAll('.inbox-match-bar span')).find(el => el.textContent?.includes('buyer@buyer.example'));
    expect(add?.textContent).toContain('buyer@buyer.example');
    await act(async () => { add!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); });
    expect(window.location.hash).toBe('#/customers?view=table&add=1&inbox=1&email=buyer%40buyer.example&company=Buyer&firstName=Buyer');
  });
  it('does not copy the sender name onto another unmatched body address', async () => {
    const delegate = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel, input) => channel === 'contacts:listForMatch'
      ? { success: true, data: [] }
      : channel === 'inbox:getBody'
        ? { success: true, data: '<p>Please copy partner@example.invalid</p>' }
        : delegate(channel, input));
    await mount(<InboxList />);
    await act(async () => { Array.from(host.querySelectorAll('span')).find(el => el.textContent === 'Fixture mail')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); });
    const add = Array.from(host.querySelectorAll('.inbox-match-bar span')).find(el => el.textContent?.includes('partner@example.invalid'));
    await act(async () => { add!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); });
    expect(window.location.hash).toBe('#/customers?view=table&add=1&inbox=1&email=partner%40example.invalid&company=Example');
    expect(window.location.hash).not.toContain('firstName');
  });
  it('matches an address-header contact without turning internal addresses into add prompts', async () => {
    const delegate = invoke.getMockImplementation()!;
    const colleague = { id: 9, email: 'colleague@buyer.example', companyName: 'Buyer Team', centerReference: { contactId: 9, customerId: 'customer-team' } };
    invoke.mockImplementation(async (channel, input) => {
      if (channel === 'inbox:list') return { success: true, data: [{ id: 1, fromEmail: contact.email, fromName: 'Buyer', subject: 'Fixture mail', bodyPreview: 'Fixture', classification: 'other', matchedContactId: null, isRead: 1, receivedAt: '2026-10-14T00:00:00Z', to: 'sales@example.test, colleague@buyer.example', cc: 'internal@example.test' }] };
      if (channel === 'contacts:listForMatch') return { success: true, data: [{ id: 7, email: contact.email, companyName: contact.companyName, contactVersion: contact.contactVersion, centerReference: reference }, { ...colleague, contactVersion: 2 }] };
      return delegate(channel, input);
    });
    await mount(<InboxList />);
    await act(async () => { Array.from(host.querySelectorAll('span')).find(el => el.textContent === 'Fixture mail')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); });
    expect(host.textContent).toContain('邮件中的其他联系人 1 人');
    expect(host.textContent).toContain('colleague@buyer.example');
    expect(host.querySelector('.inbox-match-bar')?.textContent).not.toContain('internal@example.test');
  });
  it('shows a contact lookup failure instead of claiming no addresses were extracted', async () => {
    const delegate = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel, input) => channel === 'contacts:listForMatch'
      ? { success: false, error: '中心联系人暂时不可用' }
      : delegate(channel, input));
    await mount(<InboxList />);
    await act(async () => { Array.from(host.querySelectorAll('span')).find(el => el.textContent === 'Fixture mail')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); });
    expect(host.querySelector('.inbox-match-bar')?.textContent).toContain('联系人读取失败：中心联系人暂时不可用');
    expect(host.querySelector('.inbox-match-bar')?.textContent).not.toContain('未提取');
  });
  it('shows fetch progress and can move an in-flight refresh to the background', async () => {
    let finishFetch!: () => void;
    const waiting = new Promise<void>(resolve => { finishFetch = resolve; });
    const delegate = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel, input) => {
      if (channel === 'inbox:fetch') { await waiting; return { success: true, data: [] }; }
      return delegate(channel, input);
    });
    await mount(<InboxList />);
    await act(async () => {
      Array.from(host.querySelectorAll('button')).find(button => button.textContent?.includes('刷新'))!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
    });
    await act(async () => {
      eventHandlers.get('inbox:fetchProgress')?.({
        accountId: 1,
        email: 'sales@example.test',
        phase: 'scanning',
        scanned: 125,
        total: 500,
        newCount: 5,
        remaining: 20,
        message: undefined,
      });
      await flush();
    });
    expect(document.body.textContent).toContain('已扫描 125 封 · 新增 5 封');
    expect(document.body.textContent).toContain('另有 20 封待后续处理');
    const background = Array.from(document.querySelectorAll('button')).find(button => button.textContent === '转入后台');
    await act(async () => { background!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 350)); });
    expect(host.textContent).toContain('后台拉取中');

    const reopen = Array.from(host.querySelectorAll('button')).find(button => button.textContent?.includes('后台拉取中'))!;
    await act(async () => { reopen.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); });
    expect(reopen.textContent).toBe('刷新');
    expect(document.body.textContent).toContain('已扫描 125 封 · 新增 5 封');
    await act(async () => { finishFetch(); await flush(); });
  });
  it('renders actual mail and independent notes once in contact history', async () => {
    await mount(<CenterContactDetail reference={reference} onClose={() => {}} />);
    await act(async () => { Array.from(document.querySelectorAll('.ant-tabs-tab')).find(el => el.textContent === '往来记录')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); });
    expect(document.body.textContent).toContain('互动历史');
    expect(document.querySelectorAll('.ant-timeline-item').length).toBeGreaterThan(0);
    expect(document.querySelector('.line-clamp-2')).not.toBeNull();
    expect(document.body.textContent).toContain('Real mail subject');
    expect(document.body.textContent).toContain('Real mail preview');
    expect(document.body.textContent).toContain('Independent note');
    expect(document.body.textContent).not.toContain('Duplicate mail activity');
    expect(document.body.textContent).not.toContain('邮件往来暂未接入');
  });
  it('renders a corrected message once and separates correction audit from actual received mail', async () => {
    const original={...detail.mailEvents[0],actorId:'fixture',mailboxKey:'mailbox',messageKey:'physical-mail',eventKey:'original-key',recordedAt:'2026-10-14T00:01:00Z'};
    const corrected={...original,eventId:'correction-event',activityId:'correction-activity',eventKey:'correction-key',kind:'received',recordedAt:'2026-10-16T00:01:00Z',correctionRevision:1,correction:{previousEventKey:'original-key',classification:'other'}};
    invoke.mockImplementation(async()=>({ok:true,data:{...detail,mailEvents:[corrected,original],activities:[...detail.activities,{id:'correction-activity',note:'Duplicate correction activity',createdAt:corrected.recordedAt},{id:'outside-window',mailEventId:'outside-mail-window',mailSuperseded:true,note:'Retained older mail history',createdAt:original.occurredAt}]}}));
    await mount(<CenterContactDetail reference={reference} onClose={()=>{}}/>);
    await act(async()=>{Array.from(document.querySelectorAll('.ant-tabs-tab')).find(el=>el.textContent==='往来记录')!.dispatchEvent(new MouseEvent('click',{bubbles:true}));await flush();});
    expect(document.body.textContent?.split('Real mail subject')).toHaveLength(2);
    expect(document.body.textContent?.split('Real mail preview')).toHaveLength(2);
    expect(document.body.textContent).toContain('邮件分类更正');
    expect(document.body.textContent).toContain('更正为其他');
    expect(document.body.textContent).toContain('Retained older mail history');
    expect(document.body.textContent).toContain('历史记录（已更正）');
    expect(document.body.textContent).toContain('收到邮件');
    expect(document.body.textContent).not.toContain('Duplicate mail activity');
    expect(document.body.textContent).not.toContain('Duplicate correction activity');
  });
  it('displays automatic reply facts from touch status and clears them with a single center action', async () => {
    const delegate = invoke.getMockImplementation()!;
    let current = { ...detail, contact: { ...contact, status: '', touchStatus: 'replied' } };
    invoke.mockImplementation(async (channel, input) => {
      if (channel === ONLINE_CHANNELS.CONTACT_DETAIL) return { ok: true, data: current };
      if (channel === ONLINE_CHANNELS.CONTACT_FOLLOWUP) { current = { ...current, contact: { ...current.contact, touchStatus: input.contactStatus, status: '' } }; return { ok: true, data: current }; }
      return delegate(channel, input);
    });
    await mount(<InboxList />);
    await act(async () => { Array.from(host.querySelectorAll('span')).find(el => el.textContent === 'Fixture mail')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); });
    await act(flush);
    expect(host.querySelector('[title="点击修改状态"]')!.textContent).toBe('已回复');
    await act(async () => { host.querySelector('[title="点击修改状态"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); });
    await act(async () => { Array.from(document.querySelectorAll('.ant-dropdown-menu-item')).find(el => el.textContent === '清除状态')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); });
    await act(flush);
    expect(invoke.mock.calls.filter(call => call[0] === ONLINE_CHANNELS.CONTACT_FOLLOWUP)).toEqual([[ONLINE_CHANNELS.CONTACT_FOLLOWUP, expect.objectContaining({ ...reference, contactStatus: 'uncontacted' })]]);
    expect(host.querySelector('[title="点击修改状态"]')!.textContent).toBe('—');
    expect(invoke.mock.calls.some(call => call[0] === 'contacts:upsert' || call[0] === ONLINE_CHANNELS.CONTACT_UPDATE)).toBe(false);
  });
  it('leaves normalized duplicate email candidates unselected and uneditable', async () => {
    const delegate = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel, input) => channel === 'contacts:listForMatch' ? { success: true, data: [
      { id: 7, email: 'buyer@buyer.example', companyName: 'Candidate One', centerReference: reference },
      { id: 8, email: 'BUYER@BUYER.EXAMPLE', companyName: 'Candidate Two', centerReference: { contactId: 8, customerId: 'customer-two' } },
      { id: 9, email: 'buyer@buyer.example', companyName: 'Candidate Three', centerReference: { contactId: 9, customerId: 'customer-three' } },
    ] } : delegate(channel, input));
    await mount(<InboxList />);
    await act(async () => { Array.from(host.querySelectorAll('span')).find(el => el.textContent === 'Fixture mail')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); });
    await act(flush);
    expect(host.querySelector('[title="点击修改状态"]')).toBeNull();
    expect(host.querySelector('[title="点击修改标签"]')).toBeNull();
    expect(host.textContent).not.toContain('Candidate');
    expect(invoke.mock.calls.some(call => call[0] === ONLINE_CHANNELS.CONTACT_DETAIL)).toBe(false);
  });
  it('reports a rejected classification result instead of claiming success', async () => {
    const delegate=invoke.getMockImplementation()!;
    invoke.mockImplementation(async(channel,input)=>channel==='inbox:classify'?{success:false,error:'Fixture classification rejected'}:delegate(channel,input));
    const success=vi.spyOn(message,'success'); const error=vi.spyOn(message,'error');
    await mount(<InboxList/>);
    await act(async()=>{Array.from(host.querySelectorAll('span')).find(el=>el.textContent==='Fixture mail')!.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:10,clientY:10}));await flush();});
    await act(async()=>{Array.from(host.querySelectorAll('.ctx-item')).find(el=>el.textContent==='设为 自动回复')!.dispatchEvent(new MouseEvent('click',{bubbles:true}));await flush();});
    expect(error).toHaveBeenCalledWith('Fixture classification rejected');
    expect(success).not.toHaveBeenCalled();
  });
  it.each([['followup', true, false], ['stage', false, true]] as const)('opens only granted %s controls without requiring general edit rights', async (_kind, canFollowup, canChangeStage) => {
    const delegate = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel, input) => channel === ONLINE_CHANNELS.CONTACT_DETAIL || channel === ONLINE_CHANNELS.CONTACT_FOLLOWUP ? {ok:true,data:{...detail,canEdit:false,canFollowup,permissions:{editableFields:[],canFollowup,canChangeStage,canSendMail:true,canShare:false}}} : delegate(channel,input));
    await mount(<InboxList />);
    await act(async () => { Array.from(host.querySelectorAll('span')).find(el => el.textContent === 'Fixture mail')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); });
    await act(flush);
    expect(!!host.querySelector('[title="点击修改状态"]')).toBe(canFollowup);
    expect(!!host.querySelector('[title="点击修改标签"]')).toBe(canChangeStage);
    const title = canFollowup ? '点击修改状态' : '点击修改标签';
    const label = canFollowup ? '已触达' : '报价中';
    await act(async () => { host.querySelector(`[title="${title}"]`)!.dispatchEvent(new MouseEvent('click', {bubbles:true})); await flush(); });
    await act(async () => { Array.from(document.querySelectorAll('.ant-dropdown-menu-item')).find(el => el.textContent === label)!.dispatchEvent(new MouseEvent('click', {bubbles:true})); await flush(); });
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.CONTACT_FOLLOWUP,expect.objectContaining(canFollowup?{contactStatus:'contacted'}:{stage:'quoting'}));
    expect(invoke.mock.calls.some(call => call[0] === ONLINE_CHANNELS.CONTACT_UPDATE || call[0] === 'contacts:upsert')).toBe(false);
  });
  it('updates center state and stage atomically', async () => {
    await mount(<InboxList />);
    await act(async () => { Array.from(host.querySelectorAll('span')).find(el => el.textContent === 'Fixture mail')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); });
    await act(flush);
    await act(async () => { host.querySelector('[title="点击修改状态"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); });
    await act(async () => { Array.from(document.querySelectorAll('.ant-dropdown-menu-item')).find(el => el.textContent === '已触达')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); });
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.CONTACT_FOLLOWUP, expect.objectContaining({ ...reference, expectedVersion: 4, method: 'other', contactStatus: 'contacted' }));
    await act(async () => { host.querySelector('[title="点击修改标签"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); });
    await act(async () => { Array.from(document.querySelectorAll('.ant-dropdown-menu-item')).find(el => el.textContent === '报价中')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); });
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.CONTACT_FOLLOWUP, expect.objectContaining({ ...reference, expectedVersion: 4, method: 'note', stage: 'quoting' }));
    expect(invoke.mock.calls.filter(call => call[0] === ONLINE_CHANNELS.CONTACT_FOLLOWUP)).toHaveLength(2);
    await act(async () => { host.querySelector('[title="点击修改状态"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); });
    const statusOptions = Array.from(document.querySelectorAll('.ant-dropdown-menu-item')).map(el => el.textContent);
    expect(statusOptions).toContain('自动回复');
    expect(statusOptions).toContain('退信');
    for (const [label, classification] of [['自动回复', 'autoreply'], ['退信', 'bounce']]) {
      await act(async () => { Array.from(host.querySelectorAll('span')).find(el => el.textContent === 'Fixture mail')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 })); await flush(); });
      await act(async () => { Array.from(host.querySelectorAll('.ctx-item')).find(el => el.textContent === `设为 ${label}`)!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); });
      expect(invoke).toHaveBeenCalledWith('inbox:classify', {id:1, classification});
    }
    expect(invoke.mock.calls.some(call => call[0] === ONLINE_CHANNELS.CONTACT_UPDATE || call[0] === 'contacts:upsert')).toBe(false);
    expect(invoke.mock.calls.filter(call => call[0] === ONLINE_CHANNELS.CONTACT_FOLLOWUP)).toHaveLength(2);
  });
  it('deletes a matched center contact through its explicit center reference', async () => {
    const delegate = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel, input) => channel === ONLINE_CHANNELS.CONTACT_DELETE
      ? { ok: true, data: { deleted: [{ ...reference, contactVersion: 5 }] } }
      : delegate(channel, input));
    await mount(<InboxList />);
    await act(async () => { Array.from(host.querySelectorAll('span')).find(el => el.textContent === 'Fixture mail')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); });
    await act(flush);
    await act(async () => { host.querySelector('[title="删除该联系人"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); });
    expect(invoke.mock.calls.some(call => call[0] === ONLINE_CHANNELS.CONTACT_DELETE)).toBe(false);
    await act(async () => {
      document.querySelector<HTMLButtonElement>('.ant-modal-confirm-btns .ant-btn-dangerous')!.click();
      await flush();
    });
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.CONTACT_DELETE, expect.objectContaining({
      contacts: [expect.objectContaining({ ...reference, expectedVersion: 4 })],
      idempotencyKey: expect.any(String),
    }));
    expect(invoke.mock.calls.some(call => call[0] === 'contacts:delete')).toBe(false);
  });
  it('does not offer deletion for an assigned center contact', async () => {
    const delegate = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel, input) => channel === 'contacts:listForMatch'
      ? { success: true, data: [{ id: 7, email: contact.email, companyName: contact.companyName, contactVersion: contact.contactVersion, canDelete: false, centerReference: reference }] }
      : delegate(channel, input));
    await mount(<InboxList />);
    await act(async () => { Array.from(host.querySelectorAll('span')).find(el => el.textContent === 'Fixture mail')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); });
    expect(host.querySelector('[title="删除该联系人"]')).toBeNull();
  });
  it('renders center bounce links instead of relying on the legacy local bounce table', async () => {
    const delegate = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel, input) => {
      if (channel === 'inbox:list') return { success: true, data: [{ id: 1, fromEmail: 'mailer-daemon@example.test', fromName: 'Mail Delivery', subject: 'Delivery failed', bodyPreview: 'Bounce', classification: 'bounce', matchedContactId: null, isRead: 1, receivedAt: '2026-10-14T00:00:00Z', _centerContacts: [{ contactId: 12, customerId: 'customer-bounce', role: 'bounce', email: 'bounced@buyer.example', companyName: 'Bounce Company', contactVersion: 3, canDelete: true }] }] };
      if (channel === 'inbox:bounceMatches') return { success: true, data: [] };
      return delegate(channel, input);
    });
    await mount(<InboxList />);
    await act(async () => { Array.from(host.querySelectorAll('span')).find(el => el.textContent === 'Delivery failed')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); });
    expect(host.querySelector('.inbox-match-bar')?.textContent).toContain('被退 1 人');
    expect(host.querySelector('.inbox-match-bar')?.textContent).toContain('bounced@buyer.example');
  });
});
