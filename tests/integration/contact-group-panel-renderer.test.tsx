// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContactGroups } from '../../src/renderer/pages/customers/ContactGroups';
import { ONLINE_CHANNELS } from '../../src/shared/online-crm';

vi.mock('../../src/renderer/IdentityContext', () => ({
  useIdentity: () => ({ identity: { userId: 'fixture' }, baseUrl: 'http://fixture.invalid', status: 'authenticated' }),
}));

describe('contact group panel', () => {
  let root: Root;
  let host: HTMLDivElement;
  let client: QueryClient;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
    Object.defineProperty(window, 'api', { configurable: true, value: { invoke: vi.fn(async (channel: string) => {
      if (channel === ONLINE_CHANNELS.CONTACT_GROUPS) return { ok: true, data: { items: [{ key: 'batch-a', label: 'Batch A', count: 2, latestImportedAt: null }], total: 1 } };
      return { ok: true, data: { items: [], total: 0 } };
    }) } });
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

  it('starts on all contacts and clears the group when the user chooses all', async () => {
    const onSelect = vi.fn();
    await act(async () => root.render(<QueryClientProvider client={client}><ContactGroups onSelect={onSelect} /></QueryClientProvider>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
    expect(onSelect).not.toHaveBeenCalled();
    const all = host.querySelector<HTMLButtonElement>('.contact-group-panel-all')!;
    expect(all.textContent).toContain('全部联系人');
    expect(all.classList.contains('is-active')).toBe(true);
    await act(async () => all.click());
    expect(onSelect).toHaveBeenCalledWith(null);
  });
});
