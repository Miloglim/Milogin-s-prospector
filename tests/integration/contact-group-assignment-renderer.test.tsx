// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LegacyCustomersPage } from '../../src/renderer/pages/customers/LegacyCustomersPage';
import { ONLINE_CHANNELS } from '../../src/shared/online-crm';

vi.mock('../../src/renderer/IdentityContext', () => ({ useIdentity: () => ({ identity: { userId: 'operations-fixture', crmRoles: ['operations'] }, baseUrl: 'http://fixture.invalid', status: 'authenticated' }) }));
vi.mock('@tanstack/react-router', () => ({ useRouterState: () => ({ pathname: '/customers', searchStr: '' }) }));

const timestamp = '2026-10-27T10:00:00.000Z';
const groups = [
  { key: 'batch-a', label: 'Batch A', count: 2, companyCount: 2, countryCount: 1, touchedCount: 1, companies: ['Acme', 'Northwind'], countries: ['Brazil'], clientTypes: ['代理'], sourceLevel1: ['阿里国际站'], latestImportedAt: timestamp, latestUpdatedAt: timestamp },
  { key: 'batch-b', label: 'Batch B', count: 2, companyCount: 2, countryCount: 2, touchedCount: 2, companies: ['Contoso', 'Fabrikam'], countries: ['Chile', 'Peru'], clientTypes: ['直客'], sourceLevel1: ['展会'], latestImportedAt: timestamp, latestUpdatedAt: timestamp },
];
const contacts = [1, 2, 3].map(contactId => ({ contactId, customerId: `customer-${contactId}`, customerVersion: 1, companyId: contactId, companyName: `Company ${contactId}`, email: `contact-${contactId}@example.invalid`, firstName: `Contact ${contactId}`, lastName: null, title: null, phone: null, linkedinUrl: null, country: 'Brazil', clientType: 'agent', language: 'en', stage: 'cold', status: 'reached', tags: [], extra: {}, touchStatus: 'contacted', assignee: '', source: 'fixture', sourceDetail: null, createdAt: timestamp, updatedAt: timestamp, ownerUserId: contactId === 2 ? null : 'operations-fixture', ownerName: contactId === 2 ? null : 'Operator', origin: 'operations', state: contactId === 2 ? 'pool' : 'owned', canAssign: true }));

describe('contact group card assignment', () => {
  let root: Root; let host: HTMLDivElement; let queryClient: QueryClient; let invoke: ReturnType<typeof vi.fn>;
  const flush = () => new Promise(resolve => setTimeout(resolve, 40));
  beforeEach(() => {
    window.location.hash = '#/customers?view=groups';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host); queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(async () => { await act(async () => root.unmount()); queryClient.clear(); host.remove(); document.body.replaceChildren(); });
  const mount = async (items = groups) => {
    invoke = vi.fn(async (channel, input) => {
      if (channel === ONLINE_CHANNELS.CONTACT_GROUPS) return { ok: true, data: { items, total: items.length } };
      if (channel === ONLINE_CHANNELS.CONTACT_LIST) {
        const key = (input as { groupKey?: string }).groupKey;
        const selected = key === 'batch-a' ? contacts.slice(0, 2) : key === 'batch-b' ? contacts.slice(1) : contacts;
        return { ok: true, data: { items: selected, total: selected.length } };
      }
      if (channel === ONLINE_CHANNELS.MEMBERS) return { ok: true, data: { items: [{ userId: 'target-user', displayName: 'Target User', assignable: true }], total: 1 } };
      return { ok: false, error: { code: 'NOT_FOUND', message: 'Unexpected fixture request' } };
    });
    Object.defineProperty(window, 'api', { configurable: true, value: { invoke } });
    await act(async () => { root.render(<QueryClientProvider client={queryClient}><LegacyCustomersPage /></QueryClientProvider>); });
    await vi.waitFor(() => expect(host.querySelectorAll('.contact-group-panel-row').length).toBe(items.length), { timeout: 2000 });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
  };
  const selectAllCards = async () => {
    await act(async () => { Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === '多选')!.click(); await flush(); });
    const checks = host.querySelectorAll<HTMLInputElement>('.contact-group-panel-row input[type="checkbox"]');
    expect(checks.length).toBeGreaterThan(0);
    await act(async () => { checks.forEach(check => check.click()); await flush(); });
    await vi.waitFor(() => expect(host.querySelector('[aria-label="分配所选分组"]')).not.toBeNull());
  };

  it('deduplicates selected group contacts and opens one assignment batch', async () => {
    await mount(); await selectAllCards();
    expect(host.querySelector<HTMLInputElement>('input[placeholder="搜索邮箱、姓名、公司..."]')).not.toBeNull();
    expect(host.querySelector('.customer-contacts-page')).not.toBeNull();
    expect(host.querySelectorAll('.contact-group-metric')).toHaveLength(4);
    expect(host.querySelector('.contact-group-panel-row')?.textContent).toContain('Batch A');
    expect(host.querySelector('.contact-group-panel-row')?.textContent).toContain('阿里国际站');
    const assign = host.querySelector<HTMLButtonElement>('[aria-label="分配所选分组"]')!;
    expect(assign.disabled).toBe(false);
    await act(async () => { assign.click(); await flush(); });
    await vi.waitFor(() => expect(document.body.textContent).toContain('分配 3 个联系人'), { timeout: 2000 });
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.CONTACT_LIST, expect.objectContaining({ groupDimension: 'batch', groupKey: 'batch-a', scope: 'all', limit: 100, offset: 0 }));
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.CONTACT_LIST, expect.objectContaining({ groupDimension: 'batch', groupKey: 'batch-b', scope: 'all', limit: 100, offset: 0 }));
  });

  it('blocks a card selection above the assignment limit before reading contacts', async () => {
    await mount([{ ...groups[0], key: 'large-a', count: 101 }, { ...groups[1], key: 'large-b', count: 100 }]); await selectAllCards();
    const assign = host.querySelector<HTMLButtonElement>('[aria-label="分配所选分组"]')!;
    const readsBefore = invoke.mock.calls.filter(call => call[0] === ONLINE_CHANNELS.CONTACT_LIST).length;
    expect(assign.disabled).toBe(true);
    await act(async () => { assign.click(); await flush(); });
    expect(invoke.mock.calls.filter(call => call[0] === ONLINE_CHANNELS.CONTACT_LIST)).toHaveLength(readsBefore);
    expect(document.body.textContent).toContain('最多 200 人');
  });

  it('shows current ownership in the contact table as a tag', async () => {
    await mount();
    await vi.waitFor(() => expect(host.querySelector('.contact-ownership-tag')).not.toBeNull(), { timeout: 2000 });
    const ownership = Array.from(host.querySelectorAll('.contact-ownership-tag')).map(tag => tag.textContent);
    expect(ownership).toContain('Operator');
    expect(ownership).toContain('未分配');
  });

  it('keeps the panel header and previous rows fixed while switching dimensions', async () => {
    let resolveCompany!: (value: unknown) => void;
    const companyResult = new Promise(resolve => { resolveCompany = resolve; });
    invoke = vi.fn(async (channel, input) => {
      if (channel === ONLINE_CHANNELS.CONTACT_GROUPS) {
        if ((input as { dimension?: string }).dimension === 'company') return companyResult;
        return { ok: true, data: { items: groups, total: groups.length } };
      }
      if (channel === ONLINE_CHANNELS.CONTACT_LIST) return { ok: true, data: { items: contacts.slice(0, 2), total: 2 } };
      return { ok: false, error: { code: 'NOT_FOUND', message: 'Unexpected fixture request' } };
    });
    Object.defineProperty(window, 'api', { configurable: true, value: { invoke } });
    await act(async () => { root.render(<QueryClientProvider client={queryClient}><LegacyCustomersPage /></QueryClientProvider>); });
    await vi.waitFor(() => expect(host.querySelectorAll('.contact-group-panel-row')).toHaveLength(2), { timeout: 2000 });

    const header = host.querySelector('.contact-group-panel-head');
    const firstRow = host.querySelector('.contact-group-panel-row');
    expect(host.querySelector('.contact-group-panel-footer')).not.toBeNull();
    const companyTab = Array.from(host.querySelectorAll<HTMLElement>('.contact-group-panel .ant-segmented-item')).find(item => item.textContent === '公司')!;
    await act(async () => { companyTab.click(); await flush(); });

    expect(host.querySelector('.contact-group-panel-head')).toBe(header);
    expect(host.querySelector('.contact-group-panel-row')).toBe(firstRow);
    expect(host.querySelectorAll('.contact-group-panel-row')).toHaveLength(2);
    expect(host.querySelector('.contact-group-panel-footer')).not.toBeNull();
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.CONTACT_GROUPS, expect.objectContaining({ dimension: 'company', offset: 0 }));
    expect(invoke.mock.calls.some(([channel, input]) => channel === ONLINE_CHANNELS.CONTACT_LIST
      && (input as { groupDimension?: string }).groupDimension === 'company')).toBe(false);

    await act(async () => { resolveCompany({ ok: true, data: { items: groups, total: groups.length } }); await flush(); });
    await vi.waitFor(() => expect(host.querySelectorAll('.contact-group-panel-row')).toHaveLength(2));

    const css = readFileSync(resolve('src/renderer/pages/customers/customers.css'), 'utf8');
    expect(css).toMatch(/\.contact-group-panel\{[^}]*overflow:hidden/s);
    expect(css).toMatch(/\.contact-group-panel-head\{[^}]*flex:0 0 34px/s);
    expect(css).toMatch(/\.contact-group-panel-list\{[^}]*flex:1 1 auto/s);
    expect(css).toMatch(/\.contact-group-panel-footer\{[^}]*flex:0 0 28px/s);
  });
});
