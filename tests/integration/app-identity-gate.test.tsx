// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Identity, OnlineSessionSnapshot, Result } from '../../src/shared/online-crm';
import { ONLINE_CHANNELS as CHANNEL } from '../../src/shared/online-crm';

vi.mock('../../src/renderer/router', () => {
  const listeners = new Set<() => void>();
  const state = { location: { pathname: '/customers' } };
  return { router: {
    state,
    subscribe: vi.fn((_event: string, listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); }),
    navigate: vi.fn(({ to }: { to: string }) => { state.location.pathname = to; listeners.forEach(listener => listener()); }),
  } };
});
vi.mock('@tanstack/react-router', () => ({ RouterProvider: () => <div data-testid="business-router">Business routes</div> }));
vi.mock('../../src/renderer/components/layout/AppLayout', () => ({ TitleBar: () => <div>Title bar</div> }));
vi.mock('../../src/renderer/components/ui/dot-pattern', () => ({ DotPattern: () => <svg /> }));
vi.mock('../../src/renderer/components/DiamondLogo', () => ({ DiamondLogo: () => <svg /> }));
import { App } from '../../src/renderer/App';
import { router } from '../../src/renderer/router';

const identity: Identity = { userId: 'synthetic', displayName: 'Synthetic', email: 'synthetic@example.invalid', emailVerified: true, identityAdmin: false, crmRoles: ['sales'] };
describe('application login boundary', () => {
  let host: HTMLDivElement;
  let root: Root;
  let query: QueryClient;
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host); query = new QueryClient();
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); query.clear(); vi.restoreAllMocks(); });
  const mount = async (invoke: ReturnType<typeof vi.fn>) => {
    Object.defineProperty(window, 'api', { configurable: true, value: { invoke, on: vi.fn(() => () => {}) } });
    await act(async () => root.render(<QueryClientProvider client={query}><App /></QueryClientProvider>));
  };
  it('never mounts a route while restoring or logged out; creation opens a real form without making requests', async () => {
    let complete!: (value: Result<OnlineSessionSnapshot>) => void;
    const pending = new Promise<Result<OnlineSessionSnapshot>>(resolve => { complete = resolve; });
    const invoke = vi.fn(async () => await pending);
    await mount(invoke);
    expect(host.querySelector('[data-testid="business-router"]')).toBeNull();
    expect(host.querySelector('form')).toBeNull();
    await act(async () => { complete({ ok: true, data: { identity: null, remembered: false, baseUrl: 'http://127.0.0.1:55844' } }); await pending; });
    expect(host.querySelector('#product-login-title')?.textContent).toBe('登录');
    await act(async () => { Array.from(host.querySelectorAll('button')).find(button => button.textContent?.includes('创建账号'))!.click(); });
    expect(host.querySelector('#product-login-title')?.textContent).toBe('创建账号');
    expect(host.querySelector('#confirmation')).not.toBeNull();
    expect(host.textContent).not.toContain('联系账号管理员');
    expect(invoke.mock.calls.map(call=>call[0])).toEqual([CHANNEL.RESTORE,CHANNEL.ACCOUNT_LIST]);
    expect(host.querySelector('[data-testid="business-router"]')).toBeNull();
  });
  it('registers email and password only, returns to login, and exposes no configuration or developer controls', async () => {
    const invoke = vi.fn(async channel => channel === CHANNEL.REGISTER ? { ok: true, data: { email: 'new@example.invalid' } } : { ok: true, data: { identity: null, remembered: false, baseUrl: 'http://127.0.0.1:55844' } });
    await mount(invoke);
    expect(host.textContent).toContain('忘记密码');
    await act(async () => { Array.from(host.querySelectorAll('button')).find(button => button.textContent === '忘记密码')!.click(); });
    expect(invoke.mock.calls.map(call=>call[0])).toEqual([CHANNEL.RESTORE,CHANNEL.ACCOUNT_LIST]);
    expect(host.textContent).not.toMatch(/恢复账号|连接设置|开发工具|开发界面预览/);
    expect(host.querySelector('#email')?.getAttribute('spellcheck')).toBe('false');
    await act(async () => { Array.from(host.querySelectorAll('button')).find(button => button.textContent === '创建账号')!.click(); });
    for (const [id, value] of [['email', 'new@example.invalid'], ['password', 'synthetic-registration'], ['confirmation', 'synthetic-registration']]) host.querySelector<HTMLInputElement>(`#${id}`)!.value = value;
    await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(invoke).toHaveBeenCalledWith(CHANNEL.REGISTER, { email: 'new@example.invalid', password: 'synthetic-registration' });
    expect(host.querySelector('#product-login-title')?.textContent).toBe('登录');
    expect(host.querySelector<HTMLInputElement>('#email')?.value).toBe('new@example.invalid');
    expect(host.querySelector('[data-testid="business-router"]')).toBeNull();
  });
  it('shows only the restricted password form for first login', async () => {
    const invoke = vi.fn(async channel => channel === CHANNEL.PASSWORD ? { ok: true, data: undefined } : { ok: true, data: { identity: { ...identity, mustChangePassword: true }, baseUrl: 'http://127.0.0.1:55844', remembered: false } });
    await mount(invoke);
    expect(host.textContent).toContain('设置您的新密码');
    expect(host.querySelector('[data-testid="business-router"]')).toBeNull();
    expect(host.textContent).not.toContain('创建账号');
    for (const [id, value] of [['currentPassword', 'synthetic-original'], ['newPassword', 'synthetic-replacement'], ['confirmation', 'synthetic-replacement']]) {
      await act(async () => { const input = host.querySelector<HTMLInputElement>(`#${id}`)!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
    }
    await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(invoke).toHaveBeenCalledWith(CHANNEL.PASSWORD, { currentPassword: 'synthetic-original', newPassword: 'synthetic-replacement' });
    expect(host.textContent).toContain('密码已修改，请使用新密码登录');
  });
  it('mounts business routes only after main restores an unrestricted identity', async () => {
    await mount(vi.fn(async () => ({ ok: true, data: { identity, baseUrl: 'http://127.0.0.1:55844', remembered: true, localAvailable: false } })));
    expect(host.querySelector('[data-testid="business-router"]')).not.toBeNull();
    expect(host.querySelector('form')).toBeNull();
    expect(router.navigate).toHaveBeenCalledWith({to:'/customers',replace:true});
  });
  it('opens cached inbox on verified offline startup while keeping business routes available', async () => {
    await mount(vi.fn(async () => ({ ok: true, data: { identity, baseUrl: 'http://127.0.0.1:55844', remembered: true, localAvailable: true, connection: 'offline' } })));
    expect(host.querySelector('[data-testid="business-router"]')).not.toBeNull();
    expect(host.querySelector('form')).toBeNull();
    expect(router.navigate).toHaveBeenCalledWith({ to: '/inbox', replace: true });
  });
});
