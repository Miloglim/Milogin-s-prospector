// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AppLayout } from '../../src/renderer/components/layout/AppLayout';

const navigation = vi.hoisted(() => ({ pathname: '/inbox' }));

vi.mock('@tanstack/react-router', () => ({
  Outlet: () => <div data-testid="route-content">Inbox fixture</div>,
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) => select({
    location: { pathname: navigation.pathname, searchStr: '' },
  }),
}));

vi.mock('../../src/renderer/router', () => ({ KEEPALIVE_ROUTE_COMPONENTS: {} }));
vi.mock('../../src/renderer/components/layout/Sidebar', () => ({ Sidebar: () => null }));
vi.mock('../../src/renderer/components/OnboardingWizard', () => ({ OnboardingWizard: () => null }));
vi.mock('../../src/renderer/IdentityContext', () => ({
  useOptionalIdentity: () => ({ localAvailable: true, status: 'authenticated', identity: null }),
}));

describe('AppLayout full-screen routes', () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.clearAllMocks();
  });

  async function renderRoute(pathname: string) {
    navigation.pathname = pathname;
    await act(async () => {
      root.render(<AppLayout />);
      await new Promise(resolve => setTimeout(resolve, 30));
    });
    return host.querySelector('.ant-layout-content')!.firstElementChild as HTMLDivElement;
  }

  it('removes the shared padding and outer scrolling for the inbox route', async () => {
    const scrollArea = await renderRoute('/inbox');
    expect(scrollArea.style.height).toBe('100%');
    expect(scrollArea.style.minHeight).toBe('0px');
    expect(scrollArea.style.overflow).toBe('hidden');
    expect(scrollArea.style.padding).toBe('0px');
    expect(host.querySelector('[data-testid="route-content"]')?.textContent).toBe('Inbox fixture');
  });

  it('keeps the existing scroll container for other pages', async () => {
    const scrollArea = await renderRoute('/settings');
    expect(scrollArea.style.overflow).toBe('auto');
    expect(scrollArea.style.padding).toBe('16px 20px');
  });
});
