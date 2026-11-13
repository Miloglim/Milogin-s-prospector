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
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn(), useRouterState: () => {
  const url = new URL(window.location.hash.replace(/^#/, '') || '/inbox', 'http://fixture.invalid');
  return { pathname: url.pathname, searchStr: url.search };
} }));
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
      if (channel === 'inbox:syncState') return { accounts: [{ accountId: 1, email: 'sales@example.test', hasImap: true, phase: 'ready', windowFromAt: null, windowToAt: null, targetCount: 0, scannedCount: 0, newCount: 0, matchedCount: 0, remainingCount: 0, firstCompletedAt: '2026-10-14T00:00:00Z', lastIncrementalAt: null, lastError: null, updatedAt: null }], initializing: false, failed: false };
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
  it('keeps detail deletion actionable when canDelete is absent and shows the center failure', async () => {
    const delegate = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel, input) => channel === ONLINE_CHANNELS.CONTACT_DELETE
      ? { ok: false, error: { code: 'FORBIDDEN', message: '中心拒绝删除' } }
      : delegate(channel, input));
    await mount(<CenterContactDetail reference={reference} onClose={() => {}} />);
    const remove = document.querySelector<HTMLButtonElement>('[aria-label="删除联系人"]')!;
    expect(remove.disabled).toBe(false);
    await act(async () => { remove.click(); await flush(); });
    expect(document.body.textContent).not.toContain('删除该联系人？');
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.CONTACT_DELETE, expect.objectContaining({
      contacts: [expect.objectContaining({ ...reference, expectedVersion: 4 })],
      idempotencyKey: expect.any(String),
    }));
    expect(document.body.textContent).toContain('中心拒绝删除');
  });
  it('recognizes center matches and opens the explicit center route', async () => {
    await mount(<InboxList />);
    expect(host.querySelector('.inbox-clean-row')?.textContent).toContain('buyer@buyer.example');
    await act(async () => { Array.from(host.querySelectorAll('span')).find(el => el.textContent === 'Fixture mail')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); });
    await act(flush);
    await act(async () => { Array.from(host.querySelectorAll('button')).find(el => el.textContent === 'Center Company')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(window.location.hash).toBe('#/customers?view=table&centerContact=7&centerCustomer=customer-center');
    expect(invoke.mock.calls.some(call => call[0] === 'contacts:upsert' || call[0] === 'contacts:delete')).toBe(false);
  });
  it('filters the inbox through user-defined mail labels', async () => {
    const delegate = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel, input) => {
      if (channel === 'inbox:list') return { success: true, data: [
        { id: 1, fromEmail: contact.email, fromName: 'Buyer', subject: 'Labeled reply', bodyPreview: 'Fixture', classification: 'replied', matchedContactId: null, isRead: 1, receivedAt: '2026-10-14T00:00:00Z', _centerContact: reference, _contactStatus: 'replied', _labelIds: [1] },
        { id: 2, fromEmail: 'bounce@example.test', fromName: 'Mailer', subject: 'Unread bounce', bodyPreview: 'Fixture', classification: 'bounce', matchedContactId: null, isRead: 0, receivedAt: '2026-10-15T00:00:00Z', _labelIds: [] },
        { id: 3, fromEmail: 'sent@example.test', fromName: 'Sent Buyer', subject: 'Sent followup', bodyPreview: 'Fixture', classification: 'sent', matchedContactId: 7, isRead: 1, receivedAt: '2026-10-13T00:00:00Z', _labelIds: [1] },
      ] };
      if (channel === 'inbox:labels') return { success: true, data: [
        { labelId: 1, name: '重点客户', color: '#2563eb', count: 2, createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z' },
      ] };
      return delegate(channel, input);
    });
    await mount(<InboxList />);
    expect(host.querySelector('.inbox-management-pane')).not.toBeNull();
    expect(host.querySelectorAll('.inbox-management-item').length).toBeGreaterThan(6);
    expect(host.querySelector('button[title="重点客户"]')).not.toBeNull();

    await act(async () => { (host.querySelector('button[title="未读"]') as HTMLButtonElement).click(); await flush(); });
    expect(host.textContent).toContain('Unread bounce');
    expect(host.textContent).not.toContain('Labeled reply');

    await act(async () => { (host.querySelector('button[title="重点客户"]') as HTMLButtonElement).click(); await flush(); });
    expect(host.textContent).toContain('Labeled reply');
    expect(host.textContent).toContain('Sent followup');
    expect(host.textContent).not.toContain('Unread bounce');
  });
  it('shows pinned mail and AI folder suggestions with explicit confirmation actions', async () => {
    const delegate = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel, input) => {
      if (channel === 'inbox:list') return { success: true, data: [
        { id: 91, fromEmail: contact.email, fromName: 'Buyer', subject: 'Pinned quote', bodyPreview: 'Pinned', classification: 'replied', matchedContactId: null, isRead: 1, receivedAt: '2026-10-15T00:00:00Z', _centerContact: { ...reference, companyName: 'Acme Logistics' }, _pinned: true },
        { id: 92, fromEmail: 'other@acme.test', fromName: 'Operator', subject: 'Unpinned update', bodyPreview: 'Other', classification: 'replied', matchedContactId: null, isRead: 1, receivedAt: '2026-10-14T00:00:00Z', _centerContact: { contactId: 8, customerId: 'customer-2', companyName: 'Acme Logistics' }, _pinned: false },
      ] };
      if (channel === 'inbox:labels') return { success: true, data: [
        { labelId: 11, name: '重点客户', color: '#2563eb', count: 0, source: 'user', status: 'active', createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z' },
        { labelId: 12, name: 'Acme Logistics', color: '#0f766e', count: 0, candidateCount: 2, source: 'ai', status: 'suggested', createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z' },
      ] };
      if (channel === 'inbox:folderConfirm') return { success: true, data: { labelId: 12, assigned: 2 } };
      return delegate(channel, input);
    });
    await mount(<InboxList />);

    expect(host.querySelector('button[title="置顶邮件"]')).not.toBeNull();
    expect(host.textContent).toContain('Acme Logistics');
    expect(host.querySelector('button[aria-label="确认文件夹 Acme Logistics"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="删除文件夹建议 Acme Logistics"]')).not.toBeNull();

    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="确认文件夹 Acme Logistics"]')!.click(); await flush(); });
    expect(invoke).toHaveBeenCalledWith('inbox:folderConfirm', expect.objectContaining({ labelId: 12 }));

    await act(async () => { host.querySelector<HTMLButtonElement>('button[title="全部置顶邮件"]')!.click(); await flush(); });
    expect(host.textContent).toContain('Pinned quote');
    expect(host.textContent).not.toContain('Unpinned update');
  });
  it('exposes basic mail actions in the right-click menu', async () => {
    const delegate = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel, input) => {
      if (channel === 'inbox:list') return { success: true, data: [
        { id: 93, fromEmail: contact.email, fromName: 'Buyer', subject: 'Menu quote', bodyPreview: 'Menu', classification: 'replied', matchedContactId: null, isRead: 0, receivedAt: '2026-10-15T00:00:00Z', _centerContact: reference, _labelIds: [] },
      ] };
      if (channel === 'inbox:labels') return { success: true, data: [
        { labelId: 21, name: '客户文件夹', color: '#2563eb', count: 0, source: 'user', status: 'active', createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z' },
      ] };
      if (channel === 'inbox:setReadState') return { success: true, data: { updated: 1 } };
      if (channel === 'inbox:messageLabels') return { success: true, data: { labelIds: [21] } };
      return delegate(channel, input);
    });
    await mount(<InboxList />);

    await act(async () => {
      host.querySelector('.inbox-clean-row')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
      await flush();
    });
    expect(host.textContent).toContain('标为已读');
    expect(host.textContent).toContain('标为未读');
    expect(host.textContent).toContain('置顶邮件');
    expect(host.textContent).toContain('移动到文件夹');
    expect(host.textContent).toContain('客户文件夹');

    await act(async () => {
      Array.from(host.querySelectorAll<HTMLDivElement>('.ctx-item')).find(item => item.textContent === '标为未读')!.click();
      await flush();
    });
    expect(invoke).toHaveBeenCalledWith('inbox:setReadState', expect.objectContaining({ messageIds: [93], read: false }));
  });
  it('collapses the detail analysis, conversation and contact sections independently', async () => {
    const delegate = invoke.getMockImplementation()!;
    const analysis = {
      messageId: 101, category: 'quote_request' as const, priority: 'important' as const, requiresAction: true,
      summary: '仅详情显示的判断摘要', nextAction: '回复报价', dueHint: '今天', confidence: 0.9, evidence: ['Quote'],
      source: 'ai' as const, analyzerVersion: 'fixture', status: 'ready' as const, error: null, updatedAt: '2026-10-15T00:00:00Z',
    };
    invoke.mockImplementation(async (channel, input) => {
      if (channel === 'inbox:list') return { success: true, data: [
        { id: 101, fromEmail: contact.email, fromName: 'Buyer', subject: 'Collapsible quote', bodyPreview: 'Current', classification: 'replied', matchedContactId: 7, isRead: 1, receivedAt: '2026-10-15T00:00:00Z', _centerContact: reference, _analysis: analysis },
        { id: 102, fromEmail: contact.email, fromName: 'Buyer', subject: 'Re: Collapsible quote', bodyPreview: 'Earlier', classification: 'replied', matchedContactId: 7, isRead: 1, receivedAt: '2026-10-14T00:00:00Z', _centerContact: reference },
      ] };
      return delegate(channel, input);
    });
    await mount(<InboxList />);

    expect(host.textContent).toContain('仅详情显示的判断摘要');
    expect(host.querySelector('.inbox-thread-list')).not.toBeNull();
    expect(host.querySelector('.inbox-match-body')).not.toBeNull();

    await act(async () => { host.querySelector<HTMLButtonElement>('.inbox-analysis-section .inbox-detail-collapsible-heading')!.click(); await flush(); });
    expect(host.textContent).not.toContain('仅详情显示的判断摘要');

    await act(async () => { host.querySelector<HTMLButtonElement>('.inbox-thread-stack .inbox-detail-collapsible-heading')!.click(); await flush(); });
    expect(host.querySelector('.inbox-thread-list')).toBeNull();

    await act(async () => { host.querySelector<HTMLButtonElement>('.inbox-match-heading')!.click(); await flush(); });
    expect(host.querySelector('.inbox-match-body')).toBeNull();
  });
  it('filters the inbox through local AI analysis groups', async () => {
    const delegate = invoke.getMockImplementation()!;
    const analysis = {
      messageId: 1,
      category: 'quote_request' as const,
      priority: 'important' as const,
      requiresAction: true,
      summary: '客户要求报价',
      nextAction: '回复报价',
      dueHint: '今天',
      confidence: 0.92,
      evidence: ['Please quote'],
      source: 'ai' as const,
      analyzerVersion: 'fixture',
      status: 'ready' as const,
      error: null,
      updatedAt: '2026-10-14T00:00:00Z',
    };
    invoke.mockImplementation(async (channel, input) => {
      if (channel === 'inbox:list') return { success: true, data: [
        { id: 1, fromEmail: contact.email, fromName: 'Buyer', subject: 'Quote action', bodyPreview: 'Fixture', classification: 'replied', matchedContactId: null, isRead: 1, receivedAt: '2026-10-14T00:00:00Z', _analysis: analysis },
        { id: 2, fromEmail: 'newsletter@vendor.test', fromName: 'Newsletter', subject: 'Weekly marketing', bodyPreview: 'Fixture', classification: 'other', matchedContactId: null, isRead: 1, receivedAt: '2026-10-13T00:00:00Z', _analysis: { ...analysis, messageId: 2, category: 'marketing', priority: 'normal', requiresAction: false, summary: '推广' } },
        { id: 3, fromEmail: 'ops@service.test', fromName: 'Ops', subject: 'Urgent complaint', bodyPreview: 'Fixture', classification: 'replied', matchedContactId: null, isRead: 1, receivedAt: '2026-10-12T00:00:00Z', _analysis: { ...analysis, messageId: 3, category: 'complaint', priority: 'urgent', requiresAction: false, nextAction: '处理投诉', summary: '投诉' } },
        { id: 4, fromEmail: 'broken@service.test', fromName: 'Broken', subject: 'Analysis failed mail', bodyPreview: 'Fixture', classification: 'other', matchedContactId: null, isRead: 1, receivedAt: '2026-10-11T00:00:00Z', _analysis: { ...analysis, messageId: 4, status: 'failed', error: '模型超时' } },
        { id: 5, fromEmail: 'katey_huang@yqn.com', fromName: 'Katey Huang', subject: '阳明海运 WCSA FAK 运价更新', bodyPreview: '有效期至11月17日', classification: 'replied', matchedContactId: null, isRead: 1, receivedAt: '2026-10-10T00:00:00Z', _analysis: { ...analysis, messageId: 5, category: 'rate_update', priority: 'normal', requiresAction: false, nextAction: null, summary: '同事发来的运价更新' } },
        { id: 6, fromEmail: 'customer@example.test', fromName: 'Customer', subject: 'Ambiguous follow-up', bodyPreview: 'Fixture', classification: 'replied', matchedContactId: null, isRead: 1, receivedAt: '2026-10-09T00:00:00Z', _analysis: { ...analysis, messageId: 6, category: 'reply_needed', priority: 'normal', requiresAction: true, nextAction: '确认客户具体诉求', summary: '客户补充了一段信息，但收益和订单影响还不明确' } },
        { id: 7, fromEmail: 'colleague@yqn.com', fromName: 'Colleague', subject: 'Internal quote request', bodyPreview: 'Fixture', classification: 'replied', matchedContactId: null, isRead: 1, receivedAt: '2026-10-08T00:00:00Z', _accountEmail: 'sales@yqn.com', _analysis: { ...analysis, messageId: 7, category: 'quote_request', priority: 'important', requiresAction: true, nextAction: '回复同事', summary: '同事询问内部报价' } },
      ] };
      return delegate(channel, input);
    });
    await mount(<InboxList />);

    await act(async () => { (host.querySelector('button[title="待办"]') as HTMLButtonElement).click(); await flush(); });
    expect(host.querySelector('.inbox-switch-bar')).toBeNull();
    expect(host.querySelector('.inbox-todo-overview')).not.toBeNull();
    expect(host.querySelectorAll('.inbox-todo-row').length).toBeGreaterThan(0);
    expect(host.textContent).toContain('回复报价');
    expect(host.textContent).toContain('处理投诉');
    expect(host.textContent).not.toContain('Weekly marketing');
    expect(host.textContent).not.toContain('Ambiguous follow-up');
    expect(host.textContent).not.toContain('Internal quote request');

    await act(async () => { (host.querySelector('button[title="需关注"]') as HTMLButtonElement).click(); await flush(); });
    expect(host.textContent).toContain('Ambiguous follow-up');
    expect(host.textContent).not.toContain('Quote action');
    expect(host.textContent).not.toContain('Urgent complaint');
    expect(host.textContent).not.toContain('Weekly marketing');
    expect(host.textContent).toContain('Internal quote request');
    const addTodo = host.querySelector<HTMLButtonElement>('button[title="加入待办"]');
    expect(addTodo).not.toBeNull();
    await act(async () => { addTodo!.click(); await flush(); });
    expect(invoke).toHaveBeenCalledWith('inbox:todoState', expect.objectContaining({ state: 'open', idempotencyKey: expect.any(String) }));

    expect(host.querySelector('button[title="需核对"]')).toBeNull();
  });
  it('scopes actionable filters to a receiving account', async () => {
    const delegate = invoke.getMockImplementation()!;
    const analysis = {
      messageId: 1, category: 'quote_request' as const, priority: 'important' as const, requiresAction: true,
      summary: 'Quote request', nextAction: 'Reply', dueHint: 'Today', confidence: 0.9, evidence: [],
      source: 'ai' as const, analyzerVersion: 'fixture', status: 'ready' as const, error: null, updatedAt: '2026-10-15T00:00:00Z',
    };
    invoke.mockImplementation(async (channel, input) => {
      if (channel === 'inbox:list') return { success: true, data: [
        { id: 1, fromEmail: 'buyer-a@buyer-a.test', fromName: 'Buyer A', subject: 'Account A quote', bodyPreview: 'Fixture', classification: 'replied', matchedContactId: null, isRead: 0, receivedAt: '2026-10-15T00:00:00Z', accountId: 1, _accountEmail: 'sales-a@agency-a.test', _analysis: analysis },
        { id: 2, fromEmail: 'buyer-b@buyer-b.test', fromName: 'Buyer B', subject: 'Account B rate update', bodyPreview: 'Fixture', classification: 'other', matchedContactId: null, isRead: 1, receivedAt: '2026-10-14T00:00:00Z', accountId: 2, _accountEmail: 'sales-b@agency-b.test' },
      ] };
      if (channel === 'inbox:syncState') return { accounts: [
        { accountId: 1, email: 'sales-a@example.test', hasImap: true, phase: 'ready', windowFromAt: null, windowToAt: null, targetCount: 0, scannedCount: 0, newCount: 0, matchedCount: 0, remainingCount: 0, firstCompletedAt: null, lastIncrementalAt: null, lastError: null, updatedAt: null },
        { accountId: 2, email: 'sales-b@example.test', hasImap: true, phase: 'ready', windowFromAt: null, windowToAt: null, targetCount: 0, scannedCount: 0, newCount: 0, matchedCount: 0, remainingCount: 0, firstCompletedAt: null, lastIncrementalAt: null, lastError: null, updatedAt: null },
        { accountId: 3, email: 'sales-empty@example.test', hasImap: true, phase: 'ready', windowFromAt: null, windowToAt: null, targetCount: 0, scannedCount: 0, newCount: 0, matchedCount: 0, remainingCount: 0, firstCompletedAt: null, lastIncrementalAt: null, lastError: null, updatedAt: null },
      ], initializing: false, failed: false };
      return delegate(channel, input);
    });
    await mount(<InboxList />);

    expect(host.querySelector('button[title="sales-empty@example.test"]')).not.toBeNull();
    expect(host.textContent).toContain('待办');
    await act(async () => { (host.querySelector('button[title="sales-a@example.test"]') as HTMLButtonElement).click(); await flush(); });
    expect(host.textContent).toContain('Account A quote');
    expect(host.textContent).not.toContain('Account B rate update');
    expect(host.querySelector('button[title="待办"]')?.textContent).toContain('1');
    await act(async () => { (host.querySelector('button[title="待办"]') as HTMLButtonElement).click(); await flush(); });
    await vi.waitFor(() => expect(host.querySelector('.inbox-todo-overview')).not.toBeNull());
    expect(host.textContent).toContain('Reply');
  });
  it('marks an actionable mail handled and removes it from the todo filter', async () => {
    const delegate = invoke.getMockImplementation()!;
    let handled = false;
    const analysis = {
      messageId: 1, category: 'quote_request' as const, priority: 'important' as const, requiresAction: true,
      summary: 'Quote request', nextAction: 'Reply with quote', dueHint: 'Today', confidence: 0.9, evidence: [],
      source: 'ai' as const, analyzerVersion: 'fixture', status: 'ready' as const, error: null, updatedAt: '2026-10-15T00:00:00Z',
    };
    invoke.mockImplementation(async (channel, input) => {
      if (channel === 'inbox:list') return { success: true, data: [{
        id: 1, fromEmail: 'buyer@example.test', fromName: 'Buyer', subject: 'Quote action', bodyPreview: 'Fixture',
        classification: 'replied', matchedContactId: null, isRead: 1, receivedAt: '2026-10-15T00:00:00Z',
        _analysis: analysis, _todoState: handled ? 'done' : null,
      }] };
      if (channel === 'inbox:todoState') { handled = true; return { success: true, data: { messageId: 1, state: 'done' } }; }
      return delegate(channel, input);
    });
    await mount(<InboxList />);
    await act(async () => { (host.querySelector('button[title="待办"]') as HTMLButtonElement).click(); await flush(); });
    const action = host.querySelector<HTMLButtonElement>('.inbox-todo-state')!;
    expect(action).not.toBeNull();
    await act(async () => { action.click(); await flush(); await flush(); });

    expect(invoke).toHaveBeenCalledWith('inbox:todoState', expect.objectContaining({ messageId: 1, state: 'done', idempotencyKey: expect.any(String) }));
    expect(host.querySelectorAll('.inbox-todo-row')).toHaveLength(0);
  });
  it('marks the visible todo queue handled in one batch request', async () => {
    const delegate = invoke.getMockImplementation()!;
    const handled = new Set<number>();
    const analysis = (messageId: number) => ({
      messageId, category: 'quote_request' as const, priority: 'important' as const, requiresAction: true,
      summary: `Quote ${messageId}`, nextAction: `Reply ${messageId}`, dueHint: 'Today', confidence: 0.9, evidence: [],
      source: 'ai' as const, analyzerVersion: 'fixture', status: 'ready' as const, error: null, updatedAt: '2026-10-15T00:00:00Z',
    });
    invoke.mockImplementation(async (channel, input) => {
      if (channel === 'inbox:list') return { success: true, data: [1, 2].map(id => ({
        id, fromEmail: `buyer-${id}@example.test`, fromName: `Buyer ${id}`, subject: `Quote action ${id}`, bodyPreview: 'Fixture',
        classification: 'replied', matchedContactId: null, isRead: 1, receivedAt: '2026-10-15T00:00:00Z',
        _analysis: analysis(id), _todoState: handled.has(id) ? 'done' : null,
      })) };
      if (channel === 'inbox:todoStateBatch') {
        for (const id of (input as { messageIds: number[] }).messageIds) handled.add(id);
        return { success: true, data: { updated: handled.size, state: 'done' } };
      }
      return delegate(channel, input);
    });
    await mount(<InboxList />);
    await act(async () => { (host.querySelector('button[title="待办"]') as HTMLButtonElement).click(); await flush(); });
    expect(host.querySelectorAll('.inbox-todo-row')).toHaveLength(2);

    const batch = Array.from(host.querySelectorAll<HTMLButtonElement>('.inbox-todo-overview button')).find(button => button.textContent?.includes('一键已处理'));
    expect(batch).not.toBeNull();
    await act(async () => { batch!.click(); await flush(); await flush(); });

    expect(invoke).toHaveBeenCalledWith('inbox:todoStateBatch', expect.objectContaining({ messageIds: [1, 2], state: 'done', idempotencyKey: expect.any(String) }));
    expect(host.querySelectorAll('.inbox-todo-row')).toHaveLength(0);
  });
  it('groups inbound and sent mail under one contact insight', async () => {
    const delegate = invoke.getMockImplementation()!;
    const analysis = {
      messageId: 1,
      category: 'quote_request' as const,
      priority: 'important' as const,
      requiresAction: true,
      summary: '客户看起来在询问上海到鹿特丹报价，货量还需核对',
      nextAction: '核对货量后回复报价',
      dueHint: '今天',
      confidence: 0.92,
      evidence: ['Please quote Shanghai to Rotterdam'],
      source: 'ai' as const,
      analyzerVersion: 'fixture',
      status: 'ready' as const,
      error: null,
      updatedAt: '2026-10-15T00:00:00Z',
    };
    invoke.mockImplementation(async (channel, input) => {
      if (channel === 'inbox:list') return { success: true, data: [
        { id: 1, fromEmail: contact.email, fromName: 'Buyer', subject: 'Quote followup', bodyPreview: 'Fixture', classification: 'replied', matchedContactId: null, isRead: 0, receivedAt: '2026-10-15T00:00:00Z', _analysis: analysis },
        { id: 2, fromEmail: 'sales@example.test', fromName: 'Sales', to: contact.email, subject: 'Sent catalog', bodyPreview: 'Fixture', classification: 'sent', matchedContactId: null, isRead: 1, receivedAt: '2026-10-14T00:00:00Z', _accountEmail: 'sales@example.test' },
        { id: 3, fromEmail: contact.email, fromName: 'Buyer', subject: 'Ambiguous request', bodyPreview: 'Fixture', classification: 'other', matchedContactId: null, isRead: 1, receivedAt: '2026-10-13T00:00:00Z', _analysis: { ...analysis, messageId: 3, category: 'reply_needed', priority: 'normal', requiresAction: true, nextAction: '确认客户具体诉求', summary: '客户补充信息，收益影响还不明确' } },
      ] };
      return delegate(channel, input);
    });
    await mount(<InboxList />);
    await act(async () => {
      Array.from(host.querySelectorAll<HTMLButtonElement>('.inbox-view-switch button')).find(button => button.textContent === '联系人')!.click();
      await flush();
    });
    const contactRows = () => Array.from(host.querySelectorAll<HTMLElement>('div')).filter(element => element.className.split(' ').includes('inbox-contact-row'));
    const contactRow = await vi.waitFor(() => {
      const row = contactRows()[0];
      expect(row).toBeTruthy();
      return row!;
    });

    expect(contactRow.classList.contains('is-unread')).toBe(true);
    expect(host.querySelector('.inbox-contact-row-unread')?.textContent).toContain('1 未读');
    expect(host.querySelector('.inbox-contact-row-unread i')).not.toBeNull();
    expect(host.textContent).toContain('待你回复');
    expect(host.textContent).toContain('客户看起来在询问上海到鹿特丹报价');
    expect(host.textContent).not.toContain('AI分析');
    expect(contactRow.textContent).not.toContain('依据较明确 92%');
    expect(host.textContent).toContain('3 封');
    expect(contactRow.textContent).not.toContain(contact.email);
    expect(host.querySelector('.inbox-contact-row-email')).toBeNull();

    await act(async () => { contactRow.click(); await flush(); });
    expect(host.querySelector('.inbox-contact-insight')).not.toBeNull();
    expect(host.textContent).toContain('核对货量后回复报价');

    await act(async () => { (host.querySelector('button[title="需关注"]') as HTMLButtonElement).click(); await flush(); });
    await vi.waitFor(() => expect(contactRows()).toHaveLength(1));
    await act(async () => { contactRows()[0]!.click(); await flush(); });
    expect(host.textContent).toContain('待你回复');
    expect(host.textContent).toContain('Ambiguous request');
    expect(host.textContent).toContain('AI建议处理');
    expect(host.querySelector('button[title="需核对"]')).toBeNull();
  });
  it('orders contact aggregation by latest mail instead of AI priority', async () => {
    const delegate = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel, input) => {
      if (channel === 'inbox:list') return { success: true, data: [
        {
          id: 21, fromEmail: 'alpha@example.test', fromName: 'Alpha', subject: 'Old urgent quote', bodyPreview: 'Fixture',
          classification: 'replied', matchedContactId: null, isRead: 0, receivedAt: '2026-10-10T00:00:00Z',
          _analysis: { messageId: 21, category: 'quote_request', priority: 'urgent', requiresAction: true, summary: 'Old urgent', nextAction: 'Reply', dueHint: 'Today', confidence: 0.9, evidence: [], source: 'ai', analyzerVersion: 'fixture', status: 'ready', error: null, updatedAt: '2026-10-10T00:00:00Z' },
        },
        {
          id: 22, fromEmail: 'beta@example.test', fromName: 'Beta', subject: 'Latest information', bodyPreview: 'Fixture',
          classification: 'replied', matchedContactId: null, isRead: 1, receivedAt: '2026-10-12T00:00:00Z',
        },
      ] };
      return delegate(channel, input);
    });
    await mount(<InboxList />);
    await act(async () => {
      Array.from(host.querySelectorAll<HTMLButtonElement>('.inbox-view-switch button')).find(button => button.textContent === '联系人')!.click();
      await flush();
    });
    const rows = await vi.waitFor(() => {
      const items = Array.from(host.querySelectorAll<HTMLElement>('.inbox-contact-row'));
      expect(items).toHaveLength(2);
      return items;
    });
    expect(rows[0].textContent).toContain('Beta');
    expect(rows[1].textContent).toContain('Alpha');
  });
  it('opens the inbox mail selected by a message-center notification route', async () => {
    const delegate = invoke.getMockImplementation()!;
    window.location.hash = `#/inbox?centerContact=7&centerCustomer=${encodeURIComponent(contact.customerId)}&centerMail=${encodeURIComponent('message:exact-old')}&mailSubject=${encodeURIComponent('Re: Quote request')}&mailAt=${encodeURIComponent('2026-10-12T00:00:00Z')}`;
    invoke.mockImplementation(async (channel, input) => {
      if (channel === 'inbox:list') return { success: true, data: [
        { id: 61, fromEmail: contact.email, fromName: 'Buyer', subject: 'Quote request', bodyPreview: 'Old quoted mail', classification: 'replied', matchedContactId: 7, isRead: 1, receivedAt: '2026-10-10T00:00:00Z', _centerContact: reference, _centerMessageKeys: ['message:exact-old'] },
        { id: 62, fromEmail: contact.email, fromName: 'Buyer', subject: 'Re: Quote request', bodyPreview: 'New quoted mail', classification: 'replied', matchedContactId: 7, isRead: 1, receivedAt: '2026-10-12T00:00:00Z', _centerContact: reference, _centerMessageKeys: ['message:exact-new'] },
      ] };
      return delegate(channel, input);
    });
    await mount(<InboxList />);
    expect(invoke).toHaveBeenCalledWith('inbox:list', { centerMessageKey: 'message:exact-old' });
    await vi.waitFor(() => expect(invoke.mock.calls.some(call => call[0] === 'inbox:getBody' && call[1] === 61)).toBe(true));
    expect(host.querySelector('.inbox-clean-row.is-active')?.textContent).toContain('Quote request');
  });
  it('falls back to the normalized subject when an older notification has no exact mail key', async () => {
    const delegate = invoke.getMockImplementation()!;
    window.location.hash = `#/inbox?centerContact=7&centerCustomer=${encodeURIComponent(contact.customerId)}&mailSubject=${encodeURIComponent('RES: Quotation Request FCL - QUOTE-1563-1126')}&mailAt=${encodeURIComponent('2026-10-12T00:00:00Z')}`;
    invoke.mockImplementation(async (channel, input) => {
      if (channel === 'inbox:list') return { success: true, data: [
        { id: 71, fromEmail: contact.email, fromName: 'Buyer', subject: 'Unrelated internal thread', bodyPreview: 'Wrong mail', classification: 'replied', matchedContactId: 7, isRead: 1, receivedAt: '2026-10-13T00:00:00Z', _centerContact: reference },
        { id: 72, fromEmail: contact.email, fromName: 'Buyer', subject: 'Quotation Request FCL - QUOTE-1563-1126', bodyPreview: 'Target mail', classification: 'replied', matchedContactId: 7, isRead: 1, receivedAt: '2026-10-12T00:00:00Z', _centerContact: reference },
      ] };
      return delegate(channel, input);
    });
    await mount(<InboxList />);
    await vi.waitFor(() => expect(invoke.mock.calls.some(call => call[0] === 'inbox:getBody' && call[1] === 72)).toBe(true));
    expect(host.querySelector('.inbox-clean-row.is-active')?.textContent).toContain('Quotation Request FCL');
  });
  it('clears the previous selection when a notification target is not available locally', async () => {
    const warning = vi.spyOn(message, 'warning').mockImplementation(() => undefined as never);
    const delegate = invoke.getMockImplementation()!;
    window.location.hash = `#/inbox?centerContact=7&centerCustomer=${encodeURIComponent(contact.customerId)}&centerMail=${encodeURIComponent('missing-mail-key')}&mailSubject=${encodeURIComponent('Not Synced Yet')}`;
    invoke.mockImplementation(async (channel, input) => {
      if (channel === 'inbox:list') return { success: true, data: [
        { id: 81, fromEmail: contact.email, fromName: 'Buyer', subject: 'Another mail', bodyPreview: 'Wrong mail', classification: 'replied', matchedContactId: 7, isRead: 1, receivedAt: '2026-10-13T00:00:00Z', _centerContact: reference },
      ] };
      return delegate(channel, input);
    });
    await mount(<InboxList />);
    await vi.waitFor(() => expect(warning).toHaveBeenCalledWith('目标邮件尚未同步到本地，请重新拉取后再试'));
    expect(host.querySelector('.inbox-clean-row.is-active')).toBeNull();
    expect(invoke.mock.calls.some(call => call[0] === 'inbox:getBody' && call[1] === 81)).toBe(false);
  });
  it('separates conversations by whether the latest message needs a reply or is waiting on the other side', async () => {
    const delegate = invoke.getMockImplementation()!;
    const analysis = {
      messageId: 31, category: 'quote_request' as const, priority: 'important' as const, requiresAction: true,
      summary: '客户需要报价', nextAction: '回复报价', dueHint: '今天', confidence: 0.91, evidence: [], source: 'ai' as const,
      analyzerVersion: 'fixture', status: 'ready' as const, error: null, updatedAt: '2026-10-10T00:00:00Z',
    };
    invoke.mockImplementation(async (channel, input) => {
      if (channel === 'inbox:list') return { success: true, data: [
        { id: 31, fromEmail: 'alpha@example.test', fromName: 'Alpha', subject: 'Need quote', bodyPreview: 'Fixture', classification: 'replied', matchedContactId: null, isRead: 1, receivedAt: '2026-10-10T00:00:00Z', _analysis: analysis },
        { id: 32, fromEmail: 'sales@example.test', fromName: 'Sales', to: 'alpha@example.test', subject: 'Re: Need quote', bodyPreview: 'Fixture', classification: 'sent', matchedContactId: null, isRead: 1, receivedAt: '2026-10-12T00:00:00Z', _accountEmail: 'sales@example.test' },
        { id: 33, fromEmail: 'beta@example.test', fromName: 'Beta', subject: 'Current ask', bodyPreview: 'Fixture', classification: 'replied', matchedContactId: null, isRead: 0, receivedAt: '2026-10-13T00:00:00Z', _analysis: { ...analysis, messageId: 33, summary: '客户在等新报价', updatedAt: '2026-10-13T00:00:00Z' } },
      ] };
      return delegate(channel, input);
    });
    await mount(<InboxList />);

    expect(host.querySelector('button[title="等待对方"]')).not.toBeNull();
    await act(async () => { (host.querySelector('button[title="等待对方"]') as HTMLButtonElement).click(); await flush(); });
    const waitingRows = Array.from(host.querySelectorAll('.inbox-clean-row')).map(row => row.textContent);
    expect(waitingRows).toHaveLength(1);
    expect(waitingRows[0]).toContain('Re: Need quote');

    await act(async () => { (host.querySelector('button[title="待我回复"]') as HTMLButtonElement).click(); await flush(); });
    const needsReplyRows = Array.from(host.querySelectorAll('.inbox-clean-row')).map(row => row.textContent);
    expect(needsReplyRows).toHaveLength(1);
    expect(needsReplyRows[0]).toContain('Current ask');
  });
  it('shows related mail as a compact conversation stack and switches the expanded message', async () => {
    const delegate = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel, input) => {
      if (channel === 'inbox:list') return { success: true, data: [
        { id: 41, fromEmail: 'buyer@example.test', fromName: 'Buyer', subject: 'Quote request', bodyPreview: 'Old message', classification: 'replied', matchedContactId: null, isRead: 1, receivedAt: '2026-10-10T00:00:00Z' },
        { id: 42, fromEmail: 'sales@example.test', fromName: 'Sales', to: 'buyer@example.test', subject: 'Re: Quote request', bodyPreview: 'New message', classification: 'sent', matchedContactId: null, isRead: 1, receivedAt: '2026-10-12T00:00:00Z', _accountEmail: 'sales@example.test' },
      ] };
      return delegate(channel, input);
    });
    await mount(<InboxList />);

    const threadRows = await vi.waitFor(() => {
      const rows = Array.from(host.querySelectorAll<HTMLButtonElement>('.inbox-thread-row'));
      expect(rows).toHaveLength(2);
      return rows;
    });
    expect(threadRows[1].classList.contains('is-current')).toBe(true);
    await act(async () => { threadRows[0].click(); await flush(); });
    expect(host.querySelector('.inbox-thread-row.is-current')?.textContent).toContain('Quote request');
    expect(invoke.mock.calls.some(call => call[0] === 'inbox:getBody' && call[1] === 41)).toBe(true);
  });
  it('creates a follow-up task for a sent matched message through the existing center task channel', async () => {
    const delegate = invoke.getMockImplementation()!;
    const task = {
      taskId: 'task-followup', customerId: contact.customerId, title: '跟进报价', dueAt: '2026-10-20T00:00:00.000Z', status: 'open', version: 1,
      responsibleUserId: 'fixture', responsibleName: 'Fixture', createdBy: 'fixture', createdAt: '2026-10-17T00:00:00.000Z', updatedAt: '2026-10-17T00:00:00.000Z', completedAt: null, completedBy: null, feedback: null, canManage: true,
    };
    invoke.mockImplementation(async (channel, input) => {
      if (channel === 'inbox:list') return { success: true, data: [{
        id: 51, fromEmail: 'sales@example.test', fromName: 'Sales', to: contact.email, subject: 'Quote sent', bodyPreview: 'Fixture',
        classification: 'sent', matchedContactId: null, isRead: 1, receivedAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(), _accountEmail: 'sales@example.test',
      }] };
      if (channel === ONLINE_CHANNELS.TASK_CREATE) return { ok: true, data: task };
      return delegate(channel, input);
    });
    await mount(<InboxList />);
    const create = await vi.waitFor(() => {
      const button = host.querySelector<HTMLButtonElement>('.inbox-detail-followup');
      expect(button).not.toBeNull();
      return button!;
    });
    expect(create.textContent).toContain('等待');
    await act(async () => { create.click(); await flush(); });
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.TASK_CREATE, expect.objectContaining({
      customerId: contact.customerId,
      expectedCustomerVersion: 1,
      title: expect.stringContaining('跟进'),
      idempotencyKey: expect.any(String),
    }));
    await vi.waitFor(() => expect(host.querySelector('.inbox-detail-followup')?.textContent).toContain('已建跟进'));
  });
  it('renders all mail as a clean high-density list without AI analysis rows', async () => {
    const delegate = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel, input) => {
      if (channel === 'inbox:list') return { success: true, data: [{
        id: 8, fromEmail: 'ops@service.test', fromName: 'Ops', subject: 'Plain inbox row', bodyPreview: 'Fixture',
        classification: 'replied', matchedContactId: null, isRead: 0, receivedAt: '2026-10-15T00:00:00Z',
        _analysis: {
          messageId: 8, category: 'quote_request', priority: 'important', requiresAction: true,
          summary: 'AI summary should stay out of clean mode', nextAction: 'Reply with quote', dueHint: 'Today',
          confidence: 0.9, evidence: [], source: 'ai', analyzerVersion: 'fixture', status: 'ready', error: null,
          updatedAt: '2026-10-15T00:00:00Z',
        },
      }] };
      return delegate(channel, input);
    });
    await mount(<InboxList />);

    expect(host.querySelectorAll('.inbox-clean-row')).toHaveLength(1);
    expect(host.querySelectorAll('.inbox-clean-group-header')).toHaveLength(1);
    expect(host.querySelector('.inbox-clean-group-header')?.textContent).toContain('上个月');
    expect(host.textContent).toContain('Plain inbox row');
    expect(host.querySelector('.inbox-clean-row')?.textContent).not.toContain('AI summary should stay out of clean mode');
    expect(host.querySelector('.inbox-clean-email')?.textContent).toContain('ops@service.test');
    expect(host.querySelector('.inbox-clean-status-dot')).toBeNull();

    const group = host.querySelector<HTMLButtonElement>('.inbox-clean-group-header')!;
    await act(async () => { group.click(); await flush(); });
    expect(host.querySelectorAll('.inbox-clean-row')).toHaveLength(0);
    expect(host.querySelector('.inbox-clean-group-header')?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { host.querySelector<HTMLButtonElement>('.inbox-clean-group-header')!.click(); await flush(); });
    expect(host.querySelectorAll('.inbox-clean-row')).toHaveLength(1);
  });
  it('keeps the open mail visible while updating its unread styling', async () => {
    const delegate = invoke.getMockImplementation()!;
    let read = false;
    invoke.mockImplementation(async (channel, input) => {
      if (channel === 'inbox:list') return { success: true, data: [{
        id: 9, fromEmail: 'sender@example.test', fromName: 'Sender', subject: 'Unread mail', bodyPreview: 'Fixture',
        classification: 'replied', matchedContactId: null, isRead: read ? 1 : 0, receivedAt: '2026-10-15T00:00:00Z',
      }] };
      if (channel === 'inbox:markRead') { read = true; return { success: true, data: undefined }; }
      return delegate(channel, input);
    });
    await mount(<InboxList />);
    await act(async () => { (host.querySelector('button[title="未读"]') as HTMLButtonElement).click(); await flush(); });
    expect(host.querySelector('.inbox-clean-row')?.classList.contains('is-unread')).toBe(true);
    await act(async () => {
      Array.from(host.querySelectorAll('span')).find(el => el.textContent === 'Unread mail')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
      await flush();
    });

    expect(invoke).toHaveBeenCalledWith('inbox:markRead', 9);
    expect(host.querySelectorAll('.inbox-clean-row')).toHaveLength(1);
    expect(host.querySelector('.inbox-clean-row')?.classList.contains('is-unread')).toBe(false);
  });
  it('retries failed local analysis through the registered IPC channel', async () => {
    const delegate = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel, input) => {
      if (channel === 'inbox:list') return { success: true, data: [{
        id: 4, fromEmail: 'broken@service.test', fromName: 'Broken', subject: 'Analysis failed mail',
        bodyPreview: 'Fixture', classification: 'other', matchedContactId: null, isRead: 1,
        receivedAt: '2026-10-11T00:00:00Z', _analysis: {
          messageId: 4, category: 'other', priority: 'normal', requiresAction: false,
          summary: '分析失败', nextAction: null, dueHint: null, confidence: 0, evidence: [],
          source: 'ai', analyzerVersion: 'fixture', status: 'failed', error: 'AI 返回格式不正确，请重试',
          updatedAt: '2026-10-14T00:00:00Z',
        },
      }] };
      if (channel === 'inbox:analysisRun') return { success: true, data: { queued: 1 } };
      return delegate(channel, input);
    });
    await mount(<InboxList />);
    await act(async () => { Array.from(host.querySelectorAll('span')).find(el => el.textContent === 'Analysis failed mail')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); });
    await act(async () => { Array.from(host.querySelectorAll('button')).find(el => el.textContent === '重试')!.click(); await flush(); });

    expect(invoke).toHaveBeenCalledWith('inbox:analysisRun', 4);
    expect(invoke.mock.calls.some(call => call[0] === 'inbox:analysis:run')).toBe(false);
  });
  it('assigns a user-defined label to the selected mail through the existing IPC boundary', async () => {
    const delegate = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel, input) => {
      if (channel === 'inbox:labels') return { success: true, data: [
        { labelId: 3, name: '待跟进', color: '#d97706', count: 0, createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z' },
      ] };
      if (channel === 'inbox:messageLabels') return { success: true, data: { labelIds: [3] } };
      return delegate(channel, input);
    });
    await mount(<InboxList />);
    await act(async () => { Array.from(host.querySelectorAll('span')).find(el => el.textContent === 'Fixture mail')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); });
    await act(async () => { (host.querySelector('.inbox-detail-label-trigger') as HTMLButtonElement).click(); await flush(); });
    const checkbox = document.querySelector<HTMLInputElement>('.inbox-label-picker input[type="checkbox"]')!;
    await act(async () => { checkbox.click(); await flush(); });
    expect(invoke).toHaveBeenCalledWith('inbox:messageLabels', expect.objectContaining({
      messageId: 1,
      labelIds: [3],
      idempotencyKey: expect.any(String),
    }));
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
      host.querySelector<HTMLButtonElement>('button[aria-label="拉取"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
    });
    expect(document.body.textContent).not.toContain('更早邮件');
    await act(async () => {
      eventHandlers.get('inbox:fetchProgress')?.({
        accountId: 1,
        email: 'sales@example.test',
        phase: 'scanning',
        scanned: 125,
        total: 500,
        newCount: 5,
        remaining: 20,
        processedCount: 125,
        requiredCount: 500,
        currentSubject: 'Fixture mail',
        message: undefined,
      });
      await flush();
    });
    expect(document.body.textContent).toContain('已拉取 125 / 共需拉取 500');
    expect(document.body.textContent).toContain('扫描中 · 新增 5 封');
    await act(async () => {
      eventHandlers.get('inbox:fetchProgress')?.({
        accountId: 1,
        email: 'sales@example.test',
        phase: 'scanning',
        scanned: 126,
        total: 500,
        newCount: 5,
        remaining: 20,
        processedCount: 126,
        requiredCount: 500,
        currentSubject: 'Next mail',
      });
      await flush();
    });
    expect(document.body.textContent).toContain('已拉取 126 / 共需拉取 500');
    expect(document.body.textContent).not.toContain('另有 20 封待后续处理');
    const background = Array.from(document.querySelectorAll('button')).find(button => button.textContent === '转入后台');
    await act(async () => { background!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 350)); });
    expect(host.querySelector('button[aria-label="后台拉取中"]')).not.toBeNull();

    const reopen = host.querySelector<HTMLButtonElement>('button[aria-label="后台拉取中"]')!;
    await act(async () => { reopen.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); });
    expect(host.querySelector('button[aria-label="拉取"]')).not.toBeNull();
    expect(document.body.textContent).toContain('已拉取 126 / 共需拉取 500');
    await act(async () => {
      eventHandlers.get('inbox:fetchProgress')?.({
        accountId: 1,
        email: 'sales@example.test',
        phase: 'complete',
        scanned: 500,
        total: 500,
        newCount: 5,
        remaining: 0,
        processedCount: 500,
        requiredCount: 500,
        message: '刷新完成',
      });
      finishFetch();
      await flush();
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 900)); await flush(); });
    expect(host.querySelector('.inbox-workspace')?.getAttribute('data-fetch-progress-open')).toBe('false');
  });
  it('warns without opening progress when the account has no receive mailbox', async () => {
    const delegate = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel, input) => channel === 'inbox:syncState'
      ? { accounts: [], initializing: false, failed: false }
      : delegate(channel, input));

    await mount(<InboxList />);
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="拉取"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
    });

    expect(document.body.textContent).toContain('没有可收取的邮箱账号，请先在设置中添加并启用收发信账号');
    expect(invoke.mock.calls.some(([channel]) => channel === 'inbox:fetch')).toBe(false);
    expect(document.body.textContent).not.toContain('正在启动收取');
  });
  it('shows an actionable account check when receive login is rejected', async () => {
    let finishFetch!: () => void;
    const waiting = new Promise<void>(resolve => { finishFetch = resolve; });
    const error = 'IMAP 登录失败：邮箱服务商拒绝了该账号。请在设置中更新邮箱密码/授权码，并确认邮箱已开启 IMAP。服务器返回：LOGIN failed.';
    const delegate = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel, input) => {
      if (channel === 'inbox:fetch') { await waiting; return { success: false, error }; }
      return delegate(channel, input);
    });
    await mount(<InboxList />);
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="拉取"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
    });
    await act(async () => {
      eventHandlers.get('inbox:fetchProgress')?.({
        accountId: 1,
        email: 'sales@example.test',
        phase: 'failed',
        scanned: 0,
        total: 0,
        newCount: 0,
        remaining: 0,
        message: error,
      });
      await flush();
    });
    expect(document.body.textContent).toContain('IMAP 登录失败');
    expect(document.body.textContent).toContain('邮箱密码/授权码');
    expect(Array.from(document.querySelectorAll('button')).some(button => button.textContent === '检查账号')).toBe(true);
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
    expect(host.querySelector('[title="点击修改状态"]')!.textContent).toBe('已收到');
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
