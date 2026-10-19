// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Sidebar } from '../../src/renderer/components/layout/Sidebar';
const state = vi.hoisted(() => ({ offline:false, collapsed: false, unread: 1, navigate: vi.fn(), logout: vi.fn(), search: vi.fn(), identityAdmin: false, roles: ['sales'] as Array<'admin' | 'operations' | 'sales' | 'auditor'> }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => state.navigate, useRouterState: ({ select }: { select: (value: unknown) => unknown }) => select({ location: { pathname: '/messages', search: {} } }) }));
vi.mock('../../src/renderer/AppContext', () => ({ useAppContext: () => ({ sidebarCollapsed: state.collapsed }) }));
vi.mock('../../src/renderer/IdentityContext', () => ({ useOptionalIdentity: () => ({ status:state.offline?'offline':'authenticated',localAvailable: true, identity: { displayName: '很长很长的账号名称需要省略而不会挤掉图标', email: 'test@example.invalid', identityAdmin: state.identityAdmin, crmRoles: state.roles }, logout: state.logout }) }));
vi.mock('../../src/renderer/NotificationContext', () => ({ useOptionalNotifications: () => ({ unread: state.unread }) }));
vi.mock('../../src/renderer/hooks/useAgentTranscript', () => ({ drop: vi.fn(), useRunningConvIds: () => [] }));
vi.mock('../../src/renderer/components/DiamondLogo', () => ({ DiamondLogo: () => <span /> }));
vi.mock('../../src/renderer/components/GlobalSearch', () => ({ GlobalSearch: ({ trigger }: { trigger: (click: () => void, active: boolean) => React.ReactNode }) => trigger(state.search, false) }));
describe('sidebar account, search and messages footer', () => {
  let root: Root; let host: HTMLDivElement;
  const mount = async () => act(async () => { root.render(<Sidebar />); });
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    state.offline=false;state.collapsed = false; state.unread = 1; state.identityAdmin = false; state.roles = ['sales']; state.navigate.mockClear(); state.search.mockClear(); state.logout.mockClear();
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
    vi.stubGlobal('ResizeObserver', class { constructor(_callback: () => void) {} observe(_element: HTMLElement) {} disconnect() {} });
    Object.defineProperty(window, 'api', { configurable: true, value: { invoke: vi.fn(async () => ({ success: true, data: [] })), on: () => () => {} } });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  it.each([
    { roles: ['sales'], identityAdmin: false, label: '用户' },
    { roles: ['sales', 'operations'], identityAdmin: false, label: '管理员' },
    { roles: ['operations', 'admin'], identityAdmin: false, label: '超级管理员' },
    { roles: ['sales'], identityAdmin: true, label: '超级管理员' },
    { roles: [], identityAdmin: false, label: '未授权' },
  ] as const)('greets $label without the account display name', async ({ roles, identityAdmin, label }) => {
    state.roles = [...roles]; state.identityAdmin = identityAdmin; await mount();
    const button = host.querySelector('.sidebar-account')!;
    expect(button.textContent).toBe(`你好，${label}`);
    expect(button.getAttribute('title')).toBe(`你好，${label}`);
    expect(button.textContent).not.toContain('很长');
  });
  it('places account then search then messages in one footer and confines unread to messages', async () => {
    await mount(); const footer = host.querySelector('.sidebar-footer')!;
    expect(Array.from(footer.querySelectorAll('button[aria-label]')).map(button => button.getAttribute('aria-label'))).toEqual(['账号菜单', '全局搜索', '消息中心']);
    expect(footer.querySelector('.sidebar-account [aria-label="有未读消息"]')).toBeNull();
    expect(footer.querySelector('button[aria-label="消息中心"] [aria-label="有未读消息"]')).not.toBeNull();
    expect(host.textContent).not.toContain('在线协作');
    await act(async () => { footer.querySelector<HTMLButtonElement>('button[aria-label="全局搜索"]')!.click(); }); expect(state.search).toHaveBeenCalledOnce();
    await act(async () => { footer.querySelector<HTMLButtonElement>('button[aria-label="消息中心"]')!.click(); }); expect(state.navigate).toHaveBeenCalledWith({ to: '/messages' });
    await act(async () => { footer.querySelector<HTMLButtonElement>('button[aria-label="账号菜单"]')!.click(); });
    expect(Array.from(document.querySelectorAll('[role="menuitem"]')).map(item => item.textContent).join(' ')).not.toContain('消息中心');
    const settings = Array.from(document.querySelectorAll('[role="menuitem"]')).find(item => item.textContent === '设置') as HTMLElement;
    await act(async () => settings.click()); expect(state.navigate).toHaveBeenCalledWith({ to: '/settings' });
  });
  it('requests credential-preserving switching separately from logout', async () => {
    await mount();
    await act(async()=>{host.querySelector<HTMLButtonElement>('.sidebar-account')!.click();});
    const item=Array.from(document.querySelectorAll('[role="menuitem"]')).find(item=>item.textContent==='切换账号') as HTMLElement;
    await act(async()=>item.click());
    expect(state.logout).toHaveBeenCalledWith({switchAccount:true});
  });
  it('keeps every independent button in collapsed rail and removes read badge once cleared', async () => {
    state.collapsed = true; state.unread = 0; await mount();
    const footer = host.querySelector('.sidebar-footer.is-collapsed')!;
    expect(footer.querySelectorAll('button[aria-label]')).toHaveLength(3);
    expect(footer.querySelector('[aria-label="有未读消息"]')).toBeNull();
    expect(footer.querySelector('.sidebar-account')?.textContent).toBe('');
  });
  it('allows entering customers offline while keeping live messages unavailable',async()=>{
    state.offline=true;await mount();
    expect(host.querySelector('.sidebar-brand-dot')?.classList.contains('is-offline')).toBe(true);
    const item=Array.from(host.querySelectorAll('li')).find(li=>li.textContent==='客户')!;
    expect(item.getAttribute('aria-disabled')).toBe('false');
    await act(async()=>item.click());expect(state.navigate).toHaveBeenCalledWith({to:'/customers'});
    expect(host.querySelector('button[aria-label="消息中心"]')?.hasAttribute('disabled')).toBe(true);
  });
  it('keeps the brand dot active while connected', async () => {
    await mount();
    expect(host.querySelector('.sidebar-brand-dot')?.classList.contains('is-offline')).toBe(false);
  });
  it('hides unreleased dashboard, rates and conversation history entries', async () => {
    await mount();
    expect(host.textContent).not.toContain('仪表盘');
    expect(host.textContent).not.toContain('运价库');
    expect(host.textContent).not.toContain('新对话');
    expect(host.textContent).not.toContain('还没有会话');
    expect(host.textContent).toContain('发送中心');
    expect(host.textContent).toContain('素材库');
  });
});
