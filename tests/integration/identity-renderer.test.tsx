// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IdentityProvider, useIdentity, type IdentityContextValue } from '../../src/renderer/IdentityContext';
import { ONLINE_CHANNELS as CHANNEL } from '../../src/shared/online-crm';
import type { Identity, OnlineSessionSnapshot, Result } from '../../src/shared/online-crm';

const identity: Identity = { userId: 'synthetic-a', displayName: 'Synthetic A', email: 'a@example.invalid', emailVerified: true, identityAdmin: false, crmRoles: ['sales'] };
const snapshot = (user: Identity | null): Result<OnlineSessionSnapshot> => ({ ok: true, data: { identity: user, baseUrl: 'http://127.0.0.1:55844', remembered: true, localAvailable: false } });
let current: IdentityContextValue;
function Probe() { current = useIdentity(); return <div>{current.status}:{current.identity?.userId ?? 'none'}</div>; }
describe('global renderer identity isolation', () => {
  let host: HTMLDivElement;
  let root: Root;
  let query: QueryClient;
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(async () => { await act(async () => root.unmount()); query.clear(); host.remove(); vi.restoreAllMocks(); });
  const mount = async (invoke: ReturnType<typeof vi.fn>) => {
    Object.defineProperty(window, 'api', { configurable: true, value: { invoke, on: vi.fn(() => () => {}) } });
    await act(async () => root.render(<QueryClientProvider client={query}><IdentityProvider><Probe /></IdentityProvider></QueryClientProvider>));
  };
  it('keeps the application restoring until main returns the public identity', async () => {
    let finish!: (value: Result<OnlineSessionSnapshot>) => void;
    const restore = new Promise<Result<OnlineSessionSnapshot>>(resolve => { finish = resolve; });
    const invoke = vi.fn(async () => await restore);
    await mount(invoke);
    expect(current.ready).toBe(false); expect(current.identity).toBeNull();
    expect(invoke).toHaveBeenCalledWith(CHANNEL.RESTORE);
    await act(async () => { finish(snapshot(identity)); await restore; });
    expect(current.ready).toBe(true); expect(current.status).toBe('authenticated');
    expect(current.localAvailable).toBe(false);
    expect(Object.keys(current.identity!)).not.toContain('token');
  });
  it('preserves identity and cache offline but removes them on revocation', async () => {
    let response = snapshot(identity);
    await mount(vi.fn(async () => response));
    query.setQueryData(['private'], 'Synthetic A private data');
    response = { ok: false, error: { code: 'UNAVAILABLE', message: 'Synthetic offline' } };
    await act(async () => current.refresh());
    expect(current.status).toBe('offline'); expect(current.identity?.userId).toBe('synthetic-a');
    expect(query.getQueryData(['private'])).toBe('Synthetic A private data');
    response = snapshot(null);
    await act(async () => current.refresh());
    expect(current.status).toBe('anonymous'); expect(query.getQueryData(['private'])).toBeUndefined();
  });
  it('restores the verified offline snapshot without discarding local access or cached work', async () => {
    let response: Result<OnlineSessionSnapshot> = { ok: true, data: { identity, remembered: true, baseUrl: 'http://127.0.0.1:55844', localAvailable: true, connection: 'offline' } };
    await mount(vi.fn(async () => response));
    expect(current.status).toBe('offline'); expect(current.localAvailable).toBe(true);
    query.setQueryData(['draft'], 'unfinished draft');
    response = { ok: false, error: { code: 'DATABASE_ERROR', message: 'database temporarily unavailable' } };
    await act(async () => current.refresh());
    expect(current.identity?.userId).toBe(identity.userId); expect(current.status).toBe('offline');
    response = { ok: true, data: { identity, remembered: true, baseUrl: 'http://127.0.0.1:55844', localAvailable: true, connection: 'online' } };
    await act(async () => current.refresh());
    expect(current.status).toBe('authenticated'); expect(query.getQueryData(['draft'])).toBe('unfinished draft');
  });
  it('cannot restore a revoked identity from a pending status response after logout', async () => {
    let finish!: (value: Result<OnlineSessionSnapshot>) => void;
    const stale = new Promise<Result<OnlineSessionSnapshot>>(resolve => { finish = resolve; });
    await mount(vi.fn(async channel => channel === CHANNEL.STATUS ? await stale : channel === CHANNEL.RESTORE ? snapshot(identity) : { ok: true, data: undefined }));
    let pending!: Promise<void>;
    await act(async () => { pending = current.refresh(); });
    await act(async () => current.logout());
    await act(async () => { finish(snapshot(identity)); await pending; });
    expect(current.identity).toBeNull(); expect(current.status).toBe('anonymous');
  });
  it('restricted password identity never becomes an authenticated business identity', async () => {
    const invoke = vi.fn(async channel => channel === CHANNEL.PASSWORD ? { ok: true, data: undefined } : snapshot({ ...identity, mustChangePassword: true }));
    await mount(invoke);
    expect(current.status).toBe('password-required');
    await act(async () => { await current.changePassword({ currentPassword: 'synthetic-original', newPassword: 'synthetic-replacement' }); });
    expect(current.status).toBe('anonymous'); expect(current.identity).toBeNull();
    expect(invoke).toHaveBeenCalledWith(CHANNEL.PASSWORD, { currentPassword: 'synthetic-original', newPassword: 'synthetic-replacement' });
  });
  it('clears prior account cache before logging in another account and forwards remember only to main', async () => {
    const second = { ...identity, userId: 'synthetic-b', displayName: 'Synthetic B' };
    const invoke = vi.fn(async channel => channel === CHANNEL.LOGIN ? { ok: true, data: second } : snapshot(channel === CHANNEL.RESTORE ? identity : second));
    await mount(invoke); query.setQueryData(['private'], 'Synthetic A');
    await act(async () => { await current.login({ baseUrl: 'http://127.0.0.1:55844', email: second.email, password: 'synthetic-test-password', remember: true }); });
    expect(current.identity?.userId).toBe('synthetic-b'); expect(query.getQueryData(['private'])).toBeUndefined();
    expect(invoke).toHaveBeenCalledWith(CHANNEL.LOGIN, expect.objectContaining({ remember: true }));
  });
  it('periodically checks the session when no collaboration page is mounted', async () => {
    const timers: Array<() => void> = [];
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => { timers.push(callback); return 1; }) as typeof setInterval);
    const invoke = vi.fn(async channel => snapshot(channel === CHANNEL.RESTORE ? identity : null));
    await mount(invoke);
    expect(invoke).not.toHaveBeenCalledWith(CHANNEL.BOOTSTRAP);
    await act(async () => { for (const tick of timers) tick(); });
    expect(invoke).toHaveBeenCalledWith(CHANNEL.STATUS);
    expect(current.status).toBe('anonymous');
  });
});
