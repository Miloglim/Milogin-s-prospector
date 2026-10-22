// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CenterContactDetail } from '../../src/renderer/pages/customers/CenterContactDetail';
import { ONLINE_CHANNELS } from '../../src/shared/online-crm';

vi.mock('../../src/renderer/IdentityContext', () => ({ useIdentity: () => ({ identity: { userId: 'admin' }, baseUrl: 'http://fixture.invalid', status: 'authenticated' }) }));
vi.mock('../../src/renderer/components/ContactDetail', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/renderer/components/ContactDetail')>(),
  ContactDetailLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  InfoTab: ({ onSaveField, canEdit }: { onSaveField: (field: string, value: string | null) => void; canEdit: boolean }) => <div>
    {['reached', 'replied', 'bounced', 'autoreply', 'clear'].map(value => <button key={value} disabled={!canEdit} onClick={() => onSaveField('status', value === 'clear' ? null : value)}>{value}</button>)}
  </div>,
}));
const reference = { contactId: 42, customerId: '00000000-0000-4000-8000-000000000042' };
const detail = { contact: { ...reference, contactVersion: 7, companyId: 9, email: 'fixture@example.invalid', firstName: 'Fixture', tags: [], extra: {}, touchStatus: 'uncontacted', status: '' }, company: { companyId: 9, name: 'Fixture', canEdit: true }, activities: [], canEdit: true, canFollowup: true, mailAvailable: true };

describe('original contact detail status contract', () => {
  let root: Root, host: HTMLDivElement, client: QueryClient, invoke: ReturnType<typeof vi.fn>;
  const flush = () => new Promise(resolve => setTimeout(resolve, 40));
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
    invoke = vi.fn(async () => ({ ok: true, data: detail }));
    Object.defineProperty(window, 'api', { configurable: true, value: { invoke } });
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); });
  async function click(label: string) {
    await act(async () => { root.render(<QueryClientProvider client={client}><CenterContactDetail reference={reference} onClose={() => {}} /></QueryClientProvider>); });
    await act(flush);
    await act(async () => { Array.from(host.querySelectorAll('button')).find(button => button.textContent === label)!.click(); await flush(); });
  }
  it.each([['reached', 'contacted'], ['replied', 'replied'], ['bounced', 'bounced'], ['autoreply', 'autoreply'], ['clear', 'uncontacted']])('writes %s through authoritative touch and activity rather than legacy status', async (label, contactStatus) => {
    await click(label);
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.CONTACT_FOLLOWUP, expect.objectContaining({ ...reference, expectedVersion: 7, method: 'other', contactStatus, idempotencyKey: expect.any(String) }));
    expect(invoke.mock.calls.some(([channel]) => channel === ONLINE_CHANNELS.CONTACT_UPDATE)).toBe(false);
  });
  it('opens the board with an explicit center contact reference', async () => {
    invoke.mockResolvedValue({ ok: true, data: { ...detail, contact: { ...detail.contact, touchStatus: 'contacted' } } });
    await act(async () => { root.render(<QueryClientProvider client={client}><CenterContactDetail reference={reference} onClose={() => {}} /></QueryClientProvider>); });
    await act(flush);
    const button=host.querySelector<HTMLButtonElement>('[aria-label="在CRM中查看"]')!;
    expect(button.disabled).toBe(false);
    await act(async () => { button.click(); await flush(); });
    expect(window.location.hash).toBe(`#/customers?view=board&centerContact=42&centerCustomer=${encodeURIComponent(reference.customerId)}`);
  });
});
