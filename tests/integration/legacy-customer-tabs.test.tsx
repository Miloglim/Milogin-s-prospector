// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LegacyCustomersPage } from '../../src/renderer/pages/customers/LegacyCustomersPage';
vi.mock('../../src/renderer/pages/contacts/ContactList', () => ({ ContactList: () => <div data-view="table" /> }));
vi.mock('../../src/renderer/pages/companies/CompanyPage', () => ({ CompanyPage: () => <div data-view="company" /> }));
vi.mock('../../src/renderer/IdentityContext', () => ({ useIdentity: () => ({ identity: { userId: 'tabs-test', crmRoles: ['operations'] }, baseUrl: 'http://127.0.0.1:55844', status: 'online' }) }));
vi.mock('../../src/renderer/pages/customers/CenterContactViews', () => ({ CenterContactViews: () => <div data-view="company" /> }));
vi.mock('../../src/renderer/pages/customers/ContactGroups', () => ({ ContactGroups: ({ onSelect }: { onSelect:(value:{dimension:'batch';key:string;label:string})=>void }) => <button data-view="groups" onClick={()=>onSelect({dimension:'batch',key:'fixture',label:'Fixture'})}>分组卡片</button> }));
describe('customer view switch', () => {
  let root: Root; let host: HTMLDivElement;
  beforeEach(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; window.history.replaceState(null, '', '#/customers'); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
  const waitForDeferredTable = () => act(async () => { await new Promise<void>(resolve => window.setTimeout(resolve, 220)); });
  const mount = async () => { await act(async () => { root.render(<QueryClientProvider client={new QueryClient()}><LegacyCustomersPage /></QueryClientProvider>); }); await waitForDeferredTable(); };
  const select = (label: string) => act(async () => { Array.from(host.querySelectorAll<HTMLButtonElement>('.customer-page-tab')).find(item => item.textContent === label)!.click(); });
  const checkedTab = () => Array.from(host.querySelectorAll('.customer-page-tab')).find(item => item.getAttribute('aria-selected') === 'true')?.textContent;
  it('opens contacts by default and keeps the original company and assignment tabs', async () => {
    await mount();
    expect(host.querySelector('[data-view="groups"]')).not.toBeNull();
    expect(host.textContent).not.toContain('跟进看板');
    expect(host.querySelectorAll('.customer-page-tab').length).toBe(3);
    expect(host.querySelector('.customer-page-head')).not.toBeNull();
    await select('公司'); expect(host.querySelector('[data-view="company"]')).not.toBeNull();
    await select('联系人'); expect(host.querySelector('[data-view="groups"]')).not.toBeNull(); await waitForDeferredTable();
    expect(host.querySelector('[data-view="table"]')).not.toBeNull(); expect(host.querySelector('[aria-label="联系人列表加载中"]')).toBeNull();
  });
  it('drops old board links back to the default contact entry', async () => {
    window.history.replaceState(null, '', '#/customers?view=board&detail=123'); await mount();
    expect(host.querySelector('[data-view="groups"]')).not.toBeNull();
    expect(host.querySelector('.contact-group-split')).not.toBeNull();
  });
  it('keeps the formal customer source without the retired isolation preview', async () => {
    await mount();
    expect(host.textContent).not.toContain('隔离预览'); expect(host.textContent).toContain('分配管理');
    expect(window.location.hash).toBe('#/customers'); expect(host.querySelector('[data-view="groups"]')).not.toBeNull();
  });
  it('keeps one top tab selected through repeated switching', async () => {
    await mount();
    for (const label of ['公司', '联系人', '分配管理', '联系人', '公司', '联系人']) await select(label);
    expect(checkedTab()).toBe('联系人');
  });
  it('opens the contact table directly from a deep link', async () => {
    window.history.replaceState(null, '', '#/customers?view=table&add=1&email=buyer%40example.invalid');
    await mount();
    expect(host.querySelector('[data-view="table"]')).not.toBeNull();
    expect(host.querySelector('[data-view="groups"]')).toBeNull();
    expect(checkedTab()).toBe('联系人');
  });
});
