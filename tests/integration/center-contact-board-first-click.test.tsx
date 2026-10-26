// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CenterContactViews } from '../../src/renderer/pages/customers/CenterContactViews';
import type { CenterContactPort } from '../../src/renderer/pages/customers/centerContactPort';

vi.mock('@tanstack/react-router', () => ({ useRouterState: () => ({ pathname: '/customers', searchStr: '' }) }));
vi.mock('../../src/renderer/IdentityContext', () => ({ useIdentity: () => ({ status: 'online' }) }));
vi.mock('../../src/renderer/pages/customers/CenterContactDetail', () => ({
  CenterContactDetail: ({ reference }: { reference: { contactId: number; customerId: string } | null }) =>
    reference ? <div data-testid="detail" data-contact={reference.contactId} data-customer={reference.customerId} /> : null,
}));

const row = {
  contactId: 42, customerId: 'customer-stale-cache', customerVersion: 1, contactVersion: 1,
  companyId: 7, companyName: 'Fixture Co', email: 'fixture@example.invalid', firstName: 'Fixture', lastName: null,
  title: null, phone: null, linkedinUrl: null, country: 'Brazil', clientType: 'agent', language: 'en',
  stage: 'cold', status: '', tags: [], extra: {}, touchStatus: 'contacted', assignee: '', source: 'manual',
  sourceDetail: null, createdAt: '2026-10-21T00:00:00Z', updatedAt: '2026-10-21T00:00:00Z',
  ownerUserId: null, ownerName: null, origin: 'personal', state: 'owned', relationshipStage: 'reaching',
  lastFollowupAt: null, lastFollowupNote: null, canEdit: true, canFollowup: true, canAssign: false,
};

describe('center contact board first click', () => {
  let root: Root;
  let host: HTMLDivElement;
  let client: QueryClient;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
    Object.defineProperty(window, 'api', { configurable: true, value: { invoke: vi.fn(async () => ({ success: true, data: { crm: {} } })) } });
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
  });

  it('opens detail from the clicked board contact even when the port cache has not been populated', async () => {
    const port = {
      key: 'first-click',
      records: new Map(),
      readAll: vi.fn(async () => ({ success: true, data: [row] })),
    } as unknown as CenterContactPort;
    await act(async () => root.render(<QueryClientProvider client={client}><CenterContactViews port={port} view="board" /></QueryClientProvider>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)); });
    expect(port.readAll).toHaveBeenCalledWith({ followupOnly: true });
    const contact = Array.from(host.querySelectorAll('span')).find(element => element.textContent === 'Fixture');
    expect(contact).toBeTruthy();
    await act(async () => { contact!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 40)); });
    const detail = host.querySelector('[data-testid="detail"]');
    expect(detail?.getAttribute('data-contact')).toBe('42');
    expect(detail?.getAttribute('data-customer')).toBe('customer-stale-cache');
  });
});
