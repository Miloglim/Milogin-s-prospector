// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ONLINE_CHANNELS as CHANNEL } from '../../src/shared/online-crm';
import { NotificationProvider, useOptionalNotifications, type Notifications } from '../../src/renderer/NotificationContext';
import { MessagesPage } from '../../src/renderer/pages/messages/MessagesPage';
const state = vi.hoisted(() => ({ identity: { userId: 'sales-a', crmRoles: ['sales'], crmCapabilities: ['leads.develop'] } as Record<string, unknown> | null, refresh: vi.fn(), navigate: vi.fn() }));
vi.mock('../../src/renderer/IdentityContext', () => ({ useIdentity: () => state, useOptionalIdentity: () => state }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => state.navigate }));
const item = { id: 'notification-a', eventType: 'crm.lead.assigned' as const, customerId: 'customer-b', version: 2, cursor: '1', createdAt: '2026-10-12T00:00:00Z', read: false, canOpen: true };
describe('R3 global notification ownership', () => {
  let root: Root; let host: HTMLDivElement; let invoke: ReturnType<typeof vi.fn>; let notifications: Notifications; let timers: Array<() => void>;
  function Probe() { notifications = useOptionalNotifications()!; return <span>{notifications.unread}</span>; }
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    state.identity = { userId: 'sales-a', crmRoles: ['sales'], crmCapabilities: ['leads.develop'] }; state.refresh.mockClear(); state.navigate.mockClear(); timers = [];
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void) => { timers.push(fn); return timers.length; }) as typeof setInterval);
    invoke = vi.fn(async channel => ({ ok: true, data: channel === CHANNEL.BOOTSTRAP ? { userId: 'sales-a', capabilities: ['leads.develop'], scope: 'own', summary: { mine: 0, pool: 0 } } : channel === CHANNEL.FEED ? { items: [item, item], nextCursor: '1', hasMore: false } : channel === CHANNEL.LIST ? { items: [], total: 0 } : channel === CHANNEL.DETAIL ? { customerId: 'customer-b' } : undefined }));
    Object.defineProperty(window, 'api', { configurable: true, value: { invoke } }); host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
  const mount = async () => act(async () => { root.render(<NotificationProvider><Probe /><MessagesPage /></NotificationProvider>); });
  it('has one consumer across routes, deduplicates IDs, and preserves unread until explicit read', async () => {
    await mount(); await mount(); expect(invoke.mock.calls.filter(call => call[0] === CHANNEL.FEED)).toHaveLength(1);
    expect(notifications.items).toHaveLength(1); expect(notifications.unread).toBe(1);
    expect(host.querySelector('button[aria-label="调整消息中心大小"]')).not.toBeNull();
    await act(async () => { for (const timer of timers) timer(); });
    expect(invoke.mock.calls.filter(call => call[0] === CHANNEL.FEED)).toHaveLength(2); expect(notifications.unread).toBe(1);
    expect(invoke).not.toHaveBeenCalledWith(CHANNEL.READ, item.id);
  });
  it('checks exact detail authorization before read and navigates to the real customer drawer', async () => {
    await mount(); await act(async () => { host.querySelector<HTMLButtonElement>('button.message-main')!.click(); });
    const channels = invoke.mock.calls.map(call => call[0]); expect(channels.indexOf(CHANNEL.DETAIL)).toBeLessThan(channels.indexOf(CHANNEL.READ));
    expect(invoke).toHaveBeenCalledWith(CHANNEL.DETAIL, 'customer-b'); expect(state.navigate).toHaveBeenCalledWith({ to: '/customers', search: { customerId: 'customer-b' } }); expect(notifications.unread).toBe(0);
  });
  it('names customer creation and its destination instead of showing a generic collaboration message', async () => {
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation(async channel => channel === CHANNEL.FEED ? { ok: true, data: { items: [{ ...item, eventType: 'crm.customer.created', summary: { companyName: 'Mock Jade Coast Shipping', actorName: 'admin' } }], nextCursor: '1', hasMore: false } } : normal(channel));
    await mount();
    expect(host.textContent).toContain('新增客户'); expect(host.textContent).toContain('Mock Jade Coast Shipping'); expect(host.textContent).toContain('查看客户');
    expect(host.textContent).not.toContain('协作消息');
    await act(async () => { host.querySelector<HTMLButtonElement>('button.message-main')!.click(); });
    expect(state.navigate).toHaveBeenCalledWith({ to: '/customers', search: { customerId: 'customer-b' } });
  });
  it('does not read or navigate after detail is forbidden', async () => {
    await mount(); invoke.mockImplementationOnce(async () => ({ ok: false, error: { code: 'FORBIDDEN', message: '不可读取' } }));
    await act(async () => { await notifications.open(item); }); expect(invoke.mock.calls.some(call => call[0] === CHANNEL.READ)).toBe(false); expect(notifications.items).toEqual([]); expect(state.navigate).not.toHaveBeenCalled();
  });
  it('opens a pending request with no customer access and marking read never accepts it', async () => {
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation(async channel => channel === CHANNEL.FEED ? { ok: true, data: { items: [{ ...item, eventType: 'crm.contact.assignment.requested', customerId: '', requestId: 'request-a', assignmentStatus: 'pending', summary: { companyName: 'Contact-only Company', actorName: '管理员' } }], nextCursor: '1', hasMore: false } } : normal(channel));
    await mount(); expect(host.textContent).toContain('Contact-only Company');
    await act(async () => { host.querySelector<HTMLButtonElement>('button.message-main')!.click(); });
    expect(window.location.hash).toContain('view=assignments'); expect(window.location.hash).toContain('requestId=request-a'); expect(window.location.hash).toContain('assignmentStatus=pending');
    expect(invoke).toHaveBeenCalledWith(CHANNEL.READ, item.id); expect(invoke.mock.calls.some(call => [CHANNEL.DETAIL, CHANNEL.CONTACT_DETAIL, CHANNEL.ASSIGNMENT_ACCEPT].includes(call[0]))).toBe(false);
  });
  it('opens shared invitations without probing a pending contact or implicitly accepting', async () => {
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation(async channel => channel === CHANNEL.FEED ? { ok: true, data: { items: [{ ...item, eventType: 'crm.contact.share.requested', customerId: '', shareId: 'share-a', shareTargetUserId: 'sales-a', summary: { companyName: 'Shared fixture' } }], nextCursor: '1', hasMore: false } } : normal(channel));
    await mount();
    await act(async () => { host.querySelector<HTMLButtonElement>('button.message-main')!.click(); });
    expect(window.location.hash).toBe('#/customers?view=assignments&sharing=true&shareView=incoming');
    expect(invoke).toHaveBeenCalledWith(CHANNEL.READ, item.id);
    expect(invoke.mock.calls.some(call => [CHANNEL.DETAIL, CHANNEL.CONTACT_DETAIL, CHANNEL.CONTACT_SHARE_DECIDE].includes(call[0]))).toBe(false);
  });
  it('opens an owner share notification in outgoing requests', async () => {
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation(async channel => channel === CHANNEL.FEED ? { ok: true, data: { items: [{ ...item, eventType: 'crm.contact.share.accepted', shareId: 'share-a', shareTargetUserId: 'sales-b' }], nextCursor: '1', hasMore: false } } : normal(channel));
    await mount();
    await act(async () => { host.querySelector<HTMLButtonElement>('button.message-main')!.click(); });
    expect(window.location.hash).toContain('shareView=outgoing');
    expect(invoke.mock.calls.some(call => [CHANNEL.DETAIL, CHANNEL.CONTACT_DETAIL].includes(call[0]))).toBe(false);
  });
  it('extra notifications have no resource action and do not show a per-row read control', async () => {
    const normal = invoke.getMockImplementation()!; invoke.mockImplementation(async channel => channel === CHANNEL.FEED ? { ok: true, data: { items: [{ ...item, canOpen: false, customerId: '', summary: { companyName: 'Restricted Co', actorName: 'Restricted Actor', note: 'Restricted note' } }], nextCursor: '1', hasMore: false } } : normal(channel));
    await mount(); expect(host.querySelector('button.message-main')).toBeNull(); expect(host.textContent).not.toContain('Restricted'); expect(host.querySelector('button[aria-label="标为已读"]')).toBeNull(); expect(notifications.unread).toBe(1); expect(invoke.mock.calls.some(call => call[0] === CHANNEL.DETAIL)).toBe(false);
  });
  it('renders only supplied summaries, groups dates, filters loaded unread, and keeps read separate from open', async () => {
    const normal = invoke.getMockImplementation()!;
    const summarized = { ...item, summary: { companyName: 'Authorized Co', actorName: '销售甲', note: '已电话联系' } };
    const older = { ...item, id: 'older-read', createdAt: '2026-10-10T00:00:00Z', read: true, summary: undefined };
    invoke.mockImplementation(async channel => channel === CHANNEL.FEED ? { ok: true, data: { items: [older, summarized], nextCursor: '2', hasMore: false } } : normal(channel));
    await mount();
    expect(host.textContent).toContain('Authorized Co'); expect(host.textContent).toContain('销售甲 · 已电话联系');
    expect(host.querySelectorAll('.message-date-group')).toHaveLength(2);
    expect(host.querySelectorAll('button.message-main')).toHaveLength(2);
    expect(host.querySelector('button button')).toBeNull();
    expect(invoke.mock.calls.some(call => call[0] === CHANNEL.DETAIL)).toBe(false);
    const unreadFilter = Array.from(host.querySelectorAll('.ant-segmented-item')).find(label => label.textContent === '未读')!;
    await act(async () => { (unreadFilter as HTMLElement).click(); });
    expect(host.querySelectorAll('.message-row')).toHaveLength(1);
    expect(host.querySelector('button[aria-label="标为已读"]')).toBeNull();
    await act(async () => { await notifications.read(item.id); });
    expect(host.textContent).toContain('暂无未读消息');
    expect(state.navigate).not.toHaveBeenCalled(); expect(invoke.mock.calls.some(call => call[0] === CHANNEL.DETAIL)).toBe(false);
  });
  it('replays reset history across pages, preserves matching reads, then replaces stale IDs', async () => {
    await mount(); await act(async () => { await notifications.read(item.id); });
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation(async channel => channel === CHANNEL.FEED ? { ok: true, data: { items: [item, { ...item, id: 'omitted-next', cursor: '2' }], nextCursor: '2', hasMore: false } } : normal(channel));
    await act(async () => { await notifications.refresh(); }); expect(notifications.items).toHaveLength(2);
    invoke.mockImplementation(async channel => channel === CHANNEL.FEED ? { ok: true, data: { items: [item], nextCursor: '1', hasMore: true } } : normal(channel));
    await act(async () => { await notifications.refresh(true); });
    expect(notifications.items.map(value => value.id)).toEqual([item.id, 'omitted-next']); expect(notifications.items[0].read).toBe(true);
    invoke.mockImplementation(async channel => channel === CHANNEL.FEED ? { ok: true, data: { items: [{ ...item, id: 'later-page', cursor: '3' }], nextCursor: '3', hasMore: false } } : normal(channel));
    await act(async () => { await notifications.refresh(); }); expect(notifications.items.map(value => value.id)).toEqual([item.id, 'later-page']);
  });
  it('clears account data and rejects a late in-flight feed response', async () => {
    await mount(); let finish!: (value: unknown) => void; const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation(async channel => channel === CHANNEL.FEED ? new Promise(resolve => { finish = resolve; }) : normal(channel));
    await act(async () => { void notifications.refresh(); }); state.identity = null; await mount();
    await act(async () => { finish({ ok: true, data: { items: [item], nextCursor: '1', hasMore: false } }); }); expect(notifications.items).toEqual([]);
  });
  it('keeps last data on connection failure and replays on capability changes', async () => {
    await mount(); const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation(async channel => channel === CHANNEL.FEED ? { ok: false, error: { code: 'UNAVAILABLE', message: '消息离线' } } : normal(channel));
    await act(async () => { await notifications.refresh(); }); expect(notifications.items).toHaveLength(1); expect(host.textContent).toContain('消息离线');
    state.identity = { ...state.identity, crmCapabilities: [] }; invoke.mockImplementation(normal); await mount(); expect(invoke).toHaveBeenLastCalledWith(CHANNEL.FEED, { reset: true });
  });
  it('removes opportunity summaries after ownership changes without an identity change', async () => {
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation(async channel => channel === CHANNEL.FEED ? {ok:true,data:{items:[{...item,eventType:'crm.opportunity.created',opportunityId:'opportunity-a',summary:{companyName:'Private company',note:'Private quote'}}],nextCursor:'1',hasMore:false}} : normal(channel));
    await mount(); expect(host.textContent).toContain('Private company');
    invoke.mockImplementation(async channel => channel === CHANNEL.FEED ? {ok:true,data:{items:[],nextCursor:'1',hasMore:false}} : normal(channel));
    await act(async()=>{await notifications.refresh();});
    expect(notifications.items).toEqual([]); expect(host.textContent).not.toContain('Private company');
    expect(invoke).toHaveBeenLastCalledWith(CHANNEL.FEED,{reset:true});
  });
});
