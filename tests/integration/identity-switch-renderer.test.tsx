// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Identity, OnlineSessionSnapshot, Result } from '../../src/shared/online-crm';
import { ONLINE_CHANNELS } from '../../src/shared/online-crm';
import { IdentityProvider, useIdentity } from '../../src/renderer/IdentityContext';

const identity: Identity = {
  userId: 'synthetic-a', displayName: 'A', email: 'a@example.invalid', emailVerified: true,
  identityAdmin: false, crmRoles: ['sales'],
};

function Probe() {
  const session = useIdentity();
  return <>
    <div id="state">{session.ready ? 'ready' : 'restoring'}:{session.identity?.userId ?? 'none'}</div>
    <button onClick={() => { void session.logout({ switchAccount: true }); }}>switch</button>
  </>;
}

describe('account switching boundary', () => {
  let root: Root;
  let host: HTMLDivElement;
  let query: QueryClient;
  let finishSwitch!: (value: Result<void>) => void;

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const invoke = vi.fn((channel: string) => {
      if (channel === ONLINE_CHANNELS.RESTORE) return Promise.resolve({ ok: true, data: {
        identity, baseUrl: 'http://127.0.0.1:55847', remembered: true, localAvailable: true,
      } satisfies OnlineSessionSnapshot });
      if (channel === ONLINE_CHANNELS.ACCOUNT_LIST) return Promise.resolve({ ok: true, data: { accounts: [] } });
      if (channel === ONLINE_CHANNELS.LOGOUT) return new Promise<Result<void>>(resolve => { finishSwitch = resolve; });
      return Promise.resolve({ ok: true, data: undefined });
    });
    Object.defineProperty(window, 'api', { configurable: true, value: { invoke } });
    query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root.render(<QueryClientProvider client={query}><IdentityProvider><Probe /></IdentityProvider></QueryClientProvider>);
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    query.clear();
    vi.restoreAllMocks();
  });

  it('does not render any new content before the process closes for account switching', async () => {
    expect(host.querySelector('#state')?.textContent).toBe('ready:synthetic-a');
    await act(async () => { host.querySelector<HTMLButtonElement>('button')!.click(); });
    expect(host.querySelector('#state')?.textContent).toBe('ready:synthetic-a');
    await act(async () => { finishSwitch({ ok: true, data: undefined }); await Promise.resolve(); });
    expect(host.querySelector('#state')?.textContent).toBe('ready:synthetic-a');
  });
});
