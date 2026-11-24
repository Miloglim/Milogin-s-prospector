// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Identity, OnlineSessionSnapshot } from '../../src/shared/online-crm';
import { ONLINE_CHANNELS } from '../../src/shared/online-crm';
import { IdentityProvider, useIdentity } from '../../src/renderer/IdentityContext';
import { NotificationProvider, useOptionalNotifications } from '../../src/renderer/NotificationContext';

const identity: Identity = {
  userId: 'poll-user', displayName: 'Poll', email: 'poll@example.invalid', emailVerified: true,
  identityAdmin: false, crmRoles: ['sales'],
};

function IdentityProbe({ onRender }: { onRender: () => void }) {
  const session = useIdentity();
  onRender();
  return <div id="identity">{session.identity?.userId ?? 'none'}</div>;
}

function NotificationProbe({ onRender }: { onRender: () => void }) {
  const notifications = useOptionalNotifications();
  onRender();
  return <div id="notifications">{notifications?.unread ?? -1}</div>;
}

describe('polling contexts keep value identity when the center payload is unchanged', () => {
  let root: Root;
  let host: HTMLDivElement;
  let query: QueryClient;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    const snapshot: OnlineSessionSnapshot = {
      identity, baseUrl: 'http://127.0.0.1:55847', remembered: true, localAvailable: true,
    };
    const invoke = vi.fn((channel: string) => {
      if (channel === ONLINE_CHANNELS.RESTORE || channel === ONLINE_CHANNELS.STATUS) return Promise.resolve({ ok: true, data: snapshot });
      if (channel === ONLINE_CHANNELS.ACCOUNT_LIST) return Promise.resolve({ ok: true, data: { accounts: [] } });
      if (channel === ONLINE_CHANNELS.BOOTSTRAP) return Promise.resolve({ ok: true, data: { userId: 'poll-user', capabilities: [], scope: 'self' } });
      if (channel === ONLINE_CHANNELS.FEED) return Promise.resolve({ ok: true, data: { items: [], nextCursor: '', hasMore: false } });
      return Promise.resolve({ ok: true, data: undefined });
    });
    Object.defineProperty(window, 'api', { configurable: true, value: { invoke, on: () => () => {} } });
    query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    query.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not re-render identity consumers when a poll returns the same identity', async () => {
    const renders = { count: 0 };
    await act(async () => {
      root.render(<QueryClientProvider client={query}><IdentityProvider><IdentityProbe onRender={() => { renders.count += 1; }} /></IdentityProvider></QueryClientProvider>);
    });
    const settled = renders.count;
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.querySelector('#identity')?.textContent).toBe('poll-user');
    expect(renders.count).toBe(settled);
  });

  it('does not re-render notification consumers when the feed is unchanged', async () => {
    const renders = { count: 0 };
    await act(async () => {
      root.render(<QueryClientProvider client={query}><IdentityProvider><NotificationProvider>
        <NotificationProbe onRender={() => { renders.count += 1; }} />
      </NotificationProvider></IdentityProvider></QueryClientProvider>);
    });
    const settled = renders.count;
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.querySelector('#notifications')?.textContent).toBe('0');
    expect(renders.count).toBe(settled);
  });
});
