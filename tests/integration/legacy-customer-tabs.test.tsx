// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LegacyCustomersPage } from '../../src/renderer/pages/customers/LegacyCustomersPage';
vi.mock('../../src/renderer/pages/contacts/ContactList', () => ({ ContactList: () => <div data-view="table" /> }));
vi.mock('../../src/renderer/pages/crm/CrmPipeline', () => ({ CrmPipeline: () => <div data-view="board" /> }));
vi.mock('../../src/renderer/pages/companies/CompanyPage', () => ({ CompanyPage: () => <div data-view="company" /> }));
vi.mock('../../src/renderer/IdentityContext', () => ({ useIdentity: () => ({ identity: { userId: 'tabs-test', crmRoles: ['operations'] }, baseUrl: 'http://127.0.0.1:55844', status: 'online' }) }));
vi.mock('../../src/renderer/pages/customers/CenterContactViews', () => ({ CenterContactViews: ({ view }: { view: string }) => <div data-view={view} /> }));
describe('restored original customer view switch', () => {
  let root: Root; let host: HTMLDivElement;
  beforeEach(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; window.history.replaceState(null, '', '#/customers'); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
  const waitForDeferredTable = () => act(async () => { await new Promise<void>(resolve => window.setTimeout(resolve, 80)); });
  const mount = async () => { await act(async () => { root.render(<QueryClientProvider client={new QueryClient()}><LegacyCustomersPage /></QueryClientProvider>); }); await waitForDeferredTable(); };
  const select = (label: string) => act(async () => { Array.from(host.querySelectorAll('.ant-segmented-item')).find(item => item.textContent === label)!.querySelector<HTMLInputElement>('input')!.click(); });
  it('restores all three original tabs and switches the original pages', async () => {
    await mount(); expect(host.querySelector('[data-view="table"]')).not.toBeNull();
    await select('跟进看板'); expect(host.querySelector('[data-view="board"]')).not.toBeNull();
    await select('公司'); expect(host.querySelector('[data-view="company"]')).not.toBeNull();
    await select('联系人'); await waitForDeferredTable(); expect(host.querySelector('[data-view="table"]')).not.toBeNull();
  });
  it('keeps the board selected after its child consumes the detail deep link', async () => {
    window.history.replaceState(null, '', '#/customers?view=board&detail=123'); await mount();
    expect(host.querySelector('[data-view="board"]')).not.toBeNull();
    await act(async () => { window.location.hash = '#/customers'; window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(host.querySelector('[data-view="board"]')).not.toBeNull();
    await act(async () => { window.location.hash = '#/customers?view=company&sel=7'; window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(host.querySelector('[data-view="company"]')).not.toBeNull();
  });
  it('keeps the formal customer source without the retired isolation preview', async () => {
    await mount();
    expect(host.textContent).not.toContain('隔离预览');expect(host.textContent).toContain('分配管理');
    expect(window.location.hash).toBe('#/customers'); expect(host.querySelector('[data-view="table"]')).not.toBeNull();
  });
});
