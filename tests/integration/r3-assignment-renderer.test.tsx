// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AssignmentModal } from '../../src/renderer/pages/customers/ContactAssignments';
import { ONLINE_CHANNELS as CHANNEL, type CenterContact } from '../../src/shared/online-crm';
vi.mock('../../src/renderer/IdentityContext', () => ({ useIdentity: () => ({ identity: { userId: 'manager-a', crmRoles: ['operations'] }, baseUrl: 'http://fixture.invalid', status: 'authenticated' }) }));
vi.mock('../../src/renderer/pages/customers/CenterContactDetail', () => ({ CenterContactDetail: () => null }));
vi.mock('../../src/renderer/pages/customers/CenterContactViews', () => ({ CenterContactViews: () => null }));
vi.mock('antd', () => ({
  Alert: ({ message }: { message: string }) => <div>{message}</div>,
  Space: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Modal: ({ children, onOk, onCancel, okButtonProps }: { children: React.ReactNode; onOk: () => void; onCancel: () => void; okButtonProps: { disabled: boolean } }) => <div>{children}<button disabled={okButtonProps.disabled} onClick={onOk}>确认分配</button><button onClick={onCancel}>取消</button></div>,
  Select: ({ options, onChange, mode, ...props }: { options: Array<{ value: string; label: string }>; onChange: (value: unknown) => void; mode?: string; [key: string]: unknown }) => <select aria-label={props['aria-label'] as string} onChange={event => onChange(mode ? [event.target.value] : event.target.value)}><option value="" />{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>,
  message: { success: vi.fn(), error: vi.fn() },
}));
const contact = { contactId: 17, customerId: 'customer-a', companyName: 'Synthetic', contactVersion: 3, customerVersion: 9 } as CenterContact;
describe('contact assignment modal snapshots', () => {
  let root: Root; let host: HTMLDivElement; let invoke: ReturnType<typeof vi.fn>; let closed: ReturnType<typeof vi.fn>; let queryClient: QueryClient;
  const flush = () => new Promise(resolve => setTimeout(resolve, 30));
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    invoke = vi.fn(async channel => channel === CHANNEL.MEMBERS ? { ok: true, data: { items: [{ userId: 'sales-a', displayName: 'Sales A', assignable: true }, { userId: 'ops-a', displayName: 'Operations A', assignable: false }], total: 2 } } : { ok: false, error: { code: 'UNAVAILABLE', message: 'Lost response' } });
    Object.defineProperty(window, 'api', { configurable: true, value: { invoke } }); closed = vi.fn(); queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }); host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); queryClient.clear(); host.remove(); });
  const mount = async (value = contact) => { await act(async () => root.render(<QueryClientProvider client={queryClient}><AssignmentModal contacts={[value]} close={closed} /></QueryClientProvider>)); await act(flush); };
  const choose = async (label: string, value: string) => act(async () => { const element = host.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!; element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })); });
  const submit = async () => act(async () => { host.querySelector<HTMLButtonElement>('button')!.click(); });
  it('limits recipients to assignable sales and offers authorized CRM members for notification', async () => {
    await mount(); expect(host.querySelector('[aria-label="接收人"]')!.textContent).toContain('Sales A'); expect(host.querySelector('[aria-label="接收人"]')!.textContent).not.toContain('Operations A'); expect(host.querySelector('[aria-label="通知人"]')!.textContent).toContain('Operations A');
  });
  it('loads every authorized directory page without dropping later sales choices', async () => {
    invoke.mockResolvedValueOnce({ ok: true, data: { items: [{ userId: 'ops-a', displayName: 'Operations A', assignable: false }], total: 2 } });
    invoke.mockResolvedValueOnce({ ok: true, data: { items: [{ userId: 'sales-later', displayName: 'Later Sales', assignable: true }], total: 2 } });
    await mount(); expect(invoke).toHaveBeenNthCalledWith(1, CHANNEL.MEMBERS, { search: '', limit: 100, offset: 0 }); expect(invoke).toHaveBeenNthCalledWith(2, CHANNEL.MEMBERS, { search: '', limit: 100, offset: 1 }); expect(host.querySelector('[aria-label="接收人"]')!.textContent).toContain('Later Sales');
  });
  it('retains inspected contact versions and exact request across lost-response retries and background refresh', async () => {
    await mount(); await choose('接收人', 'sales-a'); await choose('通知人', 'ops-a'); await submit(); await mount({ ...contact, contactVersion: 4 }); await submit();
    const writes = invoke.mock.calls.filter(call => call[0] === CHANNEL.ASSIGNMENT_CREATE); expect(writes).toHaveLength(2); expect(writes[0][1]).toEqual(writes[1][1]); expect(writes[0][1]).toMatchObject({ contacts: [{ contactId: 17, customerId: 'customer-a', expectedVersion: 3 }], targetUserId: 'sales-a', notifyUserIds: ['ops-a'] });
  });
  it('binds changed recipients to a new key and ignores a response after account dialog unmount', async () => {
    await mount(); await choose('接收人', 'sales-a'); await submit(); await choose('通知人', 'ops-a');
    let finish!: (value: unknown) => void; invoke.mockImplementation(async () => new Promise(resolve => { finish = resolve; })); await submit();
    const writes = invoke.mock.calls.filter(call => call[0] === CHANNEL.ASSIGNMENT_CREATE); expect(writes[0][1].idempotencyKey).not.toBe(writes[1][1].idempotencyKey);
    await act(async () => root.render(<div />)); await act(async () => { finish({ ok: true, data: { items: [] } }); }); expect(closed).not.toHaveBeenCalled();
  });
});
