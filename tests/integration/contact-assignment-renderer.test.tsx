// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { AssignmentModal, ContactAssignments } from '../../src/renderer/pages/customers/ContactAssignments';
import { ONLINE_CHANNELS as C, type CenterContact } from '../../src/shared/online-crm';
vi.mock('../../src/renderer/IdentityContext', () => ({ useIdentity: () => ({ identity: { userId: 'fixture', crmRoles: ['sales'] }, baseUrl: 'http://fixture.invalid', status: 'authenticated' }) }));
vi.mock('../../src/renderer/pages/customers/CenterContactDetail', () => ({ CenterContactDetail: () => null }));
vi.mock('../../src/renderer/pages/customers/CenterContactViews', () => ({ CenterContactViews: () => null }));
vi.mock('antd', () => ({
  Alert: ({ message }: { message: string }) => <div role="alert">{message}</div>,
  Space: ({ children }: { children: ReactNode }) => <div>{children}</div>, Tag: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Button: ({ children, onClick, disabled }: { children: ReactNode; onClick?: () => void; disabled?: boolean }) => <button disabled={disabled} onClick={onClick}>{children}</button>,
  Input: ({ value, onChange }: { value: string; onChange: (event: unknown) => void }) => <input value={value} onChange={onChange} />,
  Modal: ({ children, onOk, okButtonProps }: { children: ReactNode; onOk: () => void; okButtonProps: { disabled: boolean } }) => <div>{children}<button disabled={okButtonProps.disabled} onClick={onOk}>分配</button></div>,
  Select: ({ options, onChange, mode, ...props }: { options: Array<{ value: string; label: string }>; onChange: (value: unknown) => void; mode?: string; [key: string]: unknown }) => <select aria-label={props['aria-label'] as string} onChange={event => onChange(mode ? [event.target.value] : event.target.value)}><option value="" />{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>,
  Segmented: ({ options, onChange }: { options: Array<{ value: string; label: string }>; onChange: (value: string) => void }) => <div>{options.map(option => <button key={option.value} onClick={() => onChange(option.value)}>{option.label}</button>)}</div>,
  Table: ({ dataSource, columns }: { dataSource: Array<Record<string, unknown>>; columns: Array<{ dataIndex?: string; render?: (v: unknown, row: Record<string, unknown>) => ReactNode }> }) => <div>{dataSource.map((row, index) => <div key={index}>{columns.map((column, cell) => <span key={cell}>{column.render ? column.render(undefined, row) : String(row[column.dataIndex ?? ''] ?? '')}</span>)}</div>)}</div>,
  message: { success: vi.fn(), error: vi.fn() },
}));
describe('contact assignment decisions and selected row identity', () => {
  let root: Root, host: HTMLDivElement, qc: QueryClient, invoke: ReturnType<typeof vi.fn>;
  const flush = () => new Promise(resolve => setTimeout(resolve, 30));
  beforeEach(() => { window.location.hash = '#/customers'; (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }); invoke = vi.fn(); Object.defineProperty(window, 'api', { configurable: true, value: { invoke } }); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
  afterEach(async () => { await act(async () => root.unmount()); qc.clear(); host.remove(); });
  const mount = async (node: ReactNode) => { await act(async () => root.render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)); await act(flush); };
  it('creates requests only for selected contact IDs and preserves exact version and key on lost-response retry', async () => {
    invoke.mockImplementation(async channel => channel === C.MEMBERS ? { ok: true, data: { items: [{ userId: 'target', displayName: '用户甲', assignable: true }], total: 1 } } : { ok: false, error: { code: 'UNAVAILABLE', message: '响应丢失' } });
    const contacts = [{ contactId: 9, customerId: 'customer-a', contactVersion: 7, customerVersion: 99 }] as CenterContact[];
    await mount(<AssignmentModal contacts={contacts} close={() => {}} />);
    await act(async () => { const selector = host.querySelector('select')!; selector.value = 'target'; selector.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => host.querySelector('button')!.click()); await act(async () => host.querySelector('button')!.click());
    const writes = invoke.mock.calls.filter(call => call[0] === C.ASSIGNMENT_CREATE);
    expect(writes).toHaveLength(2); expect(writes[0]![1]).toEqual(writes[1]![1]); expect(writes[0]![1]).toMatchObject({ contacts: [{ contactId: 9, customerId: 'customer-a', expectedVersion: 7 }], targetUserId: 'target' });
    expect(invoke.mock.calls.some(call => call[0] === 'online:assign')).toBe(false);
  });
  it('pending sales requests display accept and reject, and accepting uses request identity without opening customer detail', async () => {
    invoke.mockImplementation(async channel => channel === C.ASSIGNMENT_LIST ? { ok: true, data: { items: [{ requestId: 'request-a', contactId: 9, customerId: 'customer-a', version: 4, contactName: 'Alice', companyName: 'Fixture Company', targetName: '用户甲', actorName: '管理员', createdAt: '2026-10-14', status: 'pending', canAccept: true, canReject: true, canCancel: false }], total: 1 } } : { ok: false, error: { code: 'UNAVAILABLE', message: '响应丢失' } });
    await mount(<ContactAssignments operations={false} />);
    expect(host.textContent).toContain('Alice'); expect(host.textContent).toContain('拒绝');
    const button = Array.from(host.querySelectorAll('button')).find(button => button.textContent === '接受')!;
    await act(async () => button.click()); await act(async () => button.click());
    const writes = invoke.mock.calls.filter(call => call[0] === C.ASSIGNMENT_ACCEPT); expect(writes).toHaveLength(2); expect(writes[0]![1]).toEqual(writes[1]![1]); expect(writes[0]![1]).toMatchObject({ requestId: 'request-a', expectedVersion: 4 });
    expect(invoke.mock.calls.every(call => [C.ASSIGNMENT_LIST, C.ASSIGNMENT_ACCEPT].includes(call[0]))).toBe(true);
  });
  it('an old requested notification opens the current accepted request without scanning unrelated pages', async () => {
    window.location.hash = '#/customers?view=assignments&requestId=request-a&assignmentStatus=pending';
    invoke.mockImplementation(async () => ({ ok: true, data: { items: [{ requestId: 'request-a', contactId: 9, customerId: 'customer-a', version: 5, contactName: 'Alice', companyName: 'Fixture Company', targetName: '用户甲', actorName: '管理员', createdAt: '2026-10-14', status: 'accepted', canAccept: false, canReject: false, canCancel: false }], total: 1 } }));
    await mount(<ContactAssignments operations={false} />);
    expect(invoke).toHaveBeenCalledWith(C.ASSIGNMENT_LIST, { view: 'incoming', status: 'pending', search: '', limit: 1, offset: 0, requestId: 'request-a' });
    expect(invoke).toHaveBeenCalledWith(C.ASSIGNMENT_LIST, { view: 'incoming', status: 'accepted', search: '', limit: 1, offset: 0, requestId: 'request-a' });
    expect(Array.from(host.querySelectorAll('button')).some(button => button.textContent === '接受')).toBe(false);
    expect(host.textContent).toContain('跟进');
    expect(invoke.mock.calls.every(call => call[1].offset === 0 && call[1].requestId === 'request-a')).toBe(true);
  });
});
