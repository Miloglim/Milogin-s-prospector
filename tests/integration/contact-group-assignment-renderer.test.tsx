// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LegacyCustomersPage } from '../../src/renderer/pages/customers/LegacyCustomersPage';
import { ONLINE_CHANNELS } from '../../src/shared/online-crm';

vi.mock('../../src/renderer/IdentityContext', () => ({ useIdentity: () => ({ identity: { userId: 'operations-fixture', crmRoles: ['operations'] }, baseUrl: 'http://fixture.invalid', status: 'authenticated' }) }));
vi.mock('@tanstack/react-router', () => ({ useRouterState: () => ({ pathname: '/customers', searchStr: '' }) }));

const timestamp = '2026-10-27T10:00:00.000Z';
const groups = [
  { key: 'batch-a', label: 'Batch A', count: 2, companyCount: 2, countryCount: 1, touchedCount: 1, companies: ['Acme', 'Northwind'], countries: ['Brazil'], clientTypes: ['代理'], latestUpdatedAt: timestamp },
  { key: 'batch-b', label: 'Batch B', count: 2, companyCount: 2, countryCount: 2, touchedCount: 2, companies: ['Contoso', 'Fabrikam'], countries: ['Chile', 'Peru'], clientTypes: ['直客'], latestUpdatedAt: timestamp },
];
const contacts = [1, 2, 3].map(contactId => ({ contactId, customerId: `customer-${contactId}`, customerVersion: 1, companyId: contactId, companyName: `Company ${contactId}`, email: `contact-${contactId}@example.invalid`, firstName: `Contact ${contactId}`, lastName: null, title: null, phone: null, linkedinUrl: null, country: 'Brazil', clientType: 'agent', language: 'en', stage: 'cold', status: 'reached', tags: [], extra: {}, touchStatus: 'contacted', assignee: '', source: 'fixture', sourceDetail: null, createdAt: timestamp, updatedAt: timestamp, ownerUserId: 'operations-fixture', ownerName: 'Operator', origin: 'operations', state: 'owned', canAssign: true }));

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
    await vi.waitFor(() => expect(host.querySelectorAll('.contact-group-card').length).toBe(items.length), { timeout: 2000 });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
  };
  const selectAllCards = async () => {
    const checks = host.querySelectorAll<HTMLInputElement>('.contact-group-check input');
    expect(checks.length).toBeGreaterThan(0);
    await act(async () => { checks.forEach(check => check.click()); await flush(); });
    await vi.waitFor(() => expect(host.querySelector('[aria-label="分配所选分组"]')).not.toBeNull());
  };

  it('deduplicates selected group contacts and opens one assignment batch', async () => {
    await mount(); await selectAllCards();
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
    expect(assign.disabled).toBe(true);
    expect(invoke.mock.calls.some(call => call[0] === ONLINE_CHANNELS.CONTACT_LIST)).toBe(false);
    expect(document.body.textContent).toContain('每次最多 200 人');
  });
});
