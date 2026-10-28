// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AppLayout } from '../../src/renderer/components/layout/AppLayout';

let config: { general?: Record<string, unknown> } = { general: {} };
let dialogResult: Record<string, unknown> = {};
let invoke: ReturnType<typeof vi.fn>;

vi.mock('../../src/renderer/IdentityContext', () => ({
  useOptionalIdentity: () => ({
    identity: { userId: 'account-a', email: 'a@example.invalid', mustChangePassword: false },
    baseUrl: 'https://center.example.invalid', status: 'online', localAvailable: true,
  }),
}));
vi.mock('@tanstack/react-router', () => ({
  useRouterState: () => ({ pathname: '/customers', location: { searchStr: '' } }),
  Outlet: () => <div data-testid="route-outlet" />,
}));
vi.mock('../../src/renderer/router', () => ({ KEEPALIVE_ROUTE_COMPONENTS: {} }));
vi.mock('../../src/renderer/components/layout/Sidebar', () => ({ Sidebar: () => <div /> }));
vi.mock('../../src/renderer/components/OnboardingWizard', () => ({ OnboardingWizard: () => null }));

describe('AppLayout onboarding trigger', () => {
  let root: Root; let host: HTMLDivElement;
  beforeEach(() => {
    config = { general: {} };
    dialogResult = {};
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
    invoke = vi.fn(async (channel: string) => {
      if (channel === 'accounts:list') return { success: true, data: [] };
      if (channel === 'system:getConfig') return { success: true, data: structuredClone(config) };
      if (channel === 'dashboard:stats') return { success: true, data: { totalContacts: 0, totalSent: 0, totalReplied: 0, bounceCount: 0, pipelineSummary: {}, recentActivity: [] } };
      if (channel === 'system:updateConfig') { config = structuredClone(dialogResult); return { success: true }; }
      return { success: true, data: undefined };
    });
    Object.defineProperty(window, 'api', { configurable: true, value: { invoke, on: () => () => undefined } });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); document.body.replaceChildren(); });

  async function mount() {
    await act(async () => { root.render(<AppLayout />); });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('dashboard:stats'));
  }

  it('shows the setup prompt for an empty center-account workspace', async () => {
    await mount();
    await vi.waitFor(() => expect(document.body.textContent).toContain('欢迎使用 Prospector'));
  });

  it('does not show it after this center account handled onboarding', async () => {
    config = { general: { onboarding: 'skipped' } };
    await mount();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(document.body.textContent).not.toContain('欢迎使用 Prospector');
  });

  it('persists “later” as the current account skip decision', async () => {
    invoke.mockImplementation(async (channel: string, input?: unknown) => {
      if (channel === 'accounts:list') return { success: true, data: [] };
      if (channel === 'system:getConfig') return { success: true, data: structuredClone(config) };
      if (channel === 'dashboard:stats') return { success: true, data: { totalContacts: 0, totalSent: 0, totalReplied: 0, bounceCount: 0, pipelineSummary: {}, recentActivity: [] } };
      if (channel === 'system:updateConfig') { dialogResult = input as Record<string, unknown>; config = structuredClone(dialogResult); return { success: true }; }
      return { success: true, data: undefined };
    });
    await mount();
    const later = await vi.waitFor(() => {
      const button = Array.from(document.querySelectorAll('button')).find(item => item.textContent === '稍后配置');
      expect(button).toBeTruthy();
      return button!;
    });
    await act(async () => { later.click(); await new Promise(resolve => setTimeout(resolve, 30)); });
    expect(config.general?.onboarding).toBe('skipped');
    expect(invoke).toHaveBeenCalledWith('system:updateConfig', { general: { onboarding: 'skipped' } });
  });
});
