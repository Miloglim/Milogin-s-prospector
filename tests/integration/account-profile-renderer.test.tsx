// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ONLINE_CHANNELS } from '../../src/shared/online-crm';
import { AccountProfilePage } from '../../src/renderer/pages/settings/AccountProfilePage';

vi.mock('../../src/renderer/IdentityContext', () => ({
  useIdentity: () => ({ baseUrl: 'http://center.test', identity: { userId: 'center-user', displayName: 'admin', email: 'admin@yqn.com', emailVerified: false, identityAdmin: true, crmRoles: ['admin'] } }),
}));

describe('center account profile rendering', () => {
  let root: Root;
  let host: HTMLDivElement;
  const render = async (node: ReactNode, client: QueryClient) => act(async () => { root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>); });

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

  it('fills the existing profile layout from the authenticated center summary', async () => {
    Object.defineProperty(window, 'api', { configurable: true, value: { invoke: vi.fn(async (channel: string) => {
      expect(channel).toBe(ONLINE_CHANNELS.ACCOUNT_PROFILE);
      return { ok: true, data: { userId: 'center-user', displayName: 'Zayne', avatarId: 'av-04', bio: '', growth: { totalXp: 6612, cycle: 7, level: 28, levelProgress: 16, levelCost: 21, todayXp: 18, todayKey: '2026-10-21' } } };
    }) } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(<AccountProfilePage />, client);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(host.querySelector('.account-profile-name')?.textContent).toBe('Zayne');
    expect(host.querySelector('.account-profile-main')?.textContent).toContain('用户名Zayne');
    expect(host.textContent).toContain('Lv. 28');
    expect(host.textContent).toContain('16 / 21 XP');
    expect(host.querySelector('.ant-avatar img')?.getAttribute('src')).toContain('av-04');
  });
});
