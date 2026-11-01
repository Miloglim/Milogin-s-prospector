// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { AssignmentModal, AssignmentTransferModal, ContactAssignments } from '../../src/renderer/pages/customers/ContactAssignments';
import { ContactMonitorDetail } from '../../src/renderer/pages/customers/CenterContactDetail';
import { LegacyCustomersPage } from '../../src/renderer/pages/customers/LegacyCustomersPage';
import { ONLINE_CHANNELS as C, type CenterContact, type ContactAssignment } from '../../src/shared/online-crm';
vi.mock('../../src/renderer/IdentityContext', () => ({ useIdentity: () => ({ identity: { userId: 'fixture', crmRoles: ['sales'] }, baseUrl: 'http://fixture.invalid', status: 'authenticated' }) }));
vi.mock('../../src/renderer/pages/customers/CenterContactDetail', async () => {
  const actual = await vi.importActual<typeof import('../../src/renderer/pages/customers/CenterContactDetail')>('../../src/renderer/pages/customers/CenterContactDetail');
  return { ...actual, CenterContactDetail: () => null };
});
vi.mock('../../src/renderer/components/ContactDetail', () => ({
  ContactDetailLayout: ({ children, open }: { children: ReactNode; open: boolean }) => open ? <div>{children}</div> : null,
  InfoTab: () => null,
  CRM_STAGES: [],
  STATUS_META: {},
}));
vi.mock('../../src/renderer/components/CompanyBackcheck', () => ({ CompanyBackcheck: () => null, COMPANY_BACKCHECK_UI_ENABLED: false }));
vi.mock('../../src/renderer/pages/customers/ContactSharing', () => ({ ContactShares: () => null, ContactSharingModal: () => null }));
vi.mock('../../src/renderer/pages/contacts/ContactList', () => ({ ContactList: () => null }));
vi.mock('../../src/renderer/pages/customers/ContactGroups', () => ({ ContactGroups: () => null }));
vi.mock('../../src/renderer/components/DiamondLogo', () => ({ DiamondLogo: () => null }));
vi.mock('../../src/renderer/lib/ask-ai', () => ({ askAssistant: vi.fn() }));
vi.mock('../../src/renderer/pages/customers/CenterContactViews', () => ({ CenterContactViews: () => null }));
vi.mock('antd', () => ({
  Alert: ({ message }: { message: string }) => <div role="alert">{message}</div>,
  Space: ({ children }: { children: ReactNode }) => <div>{children}</div>, Tag: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Button: ({ children, onClick, disabled, ...props }: { children: ReactNode; onClick?: () => void; disabled?: boolean; [key: string]: unknown }) => <button aria-label={props['aria-label'] as string | undefined} disabled={disabled} onClick={onClick}>{children}</button>,
  Pagination: () => null,
  Input: Object.assign(({ value, onChange }: { value: string; onChange: (event: unknown) => void }) => <input value={value} onChange={onChange} />, { TextArea: ({ value, onChange }: { value: string; onChange: (event: unknown) => void }) => <textarea value={value} onChange={onChange} /> }),
  Modal: ({ children, onOk, okText, okButtonProps }: { children: ReactNode; onOk: () => void; okText?: string; okButtonProps: { disabled: boolean } }) => <div>{children}<button disabled={okButtonProps.disabled} onClick={onOk}>{okText}</button></div>,
  Select: ({ options, onChange, mode, ...props }: { options: Array<{ value: string; label: string }>; onChange: (value: unknown) => void; mode?: string; [key: string]: unknown }) => <select aria-label={props['aria-label'] as string} onChange={event => onChange(mode ? [event.target.value] : event.target.value)}><option value="" />{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>,
  Segmented: ({ options, onChange }: { options: Array<{ value: string; label: string }>; onChange: (value: string) => void }) => <div>{options.map(option => <button key={option.value} onClick={() => onChange(option.value)}>{option.label}</button>)}</div>,
  Table: ({ dataSource, columns }: { dataSource: Array<Record<string, unknown>>; columns: Array<{ dataIndex?: string; render?: (v: unknown, row: Record<string, unknown>) => ReactNode }> }) => <div>{dataSource.map((row, index) => <div key={index}>{columns.map((column, cell) => <span key={cell}>{column.render ? column.render(undefined, row) : String(row[column.dataIndex ?? ''] ?? '')}</span>)}</div>)}</div>,
  Spin: () => <span>loading</span>,
  Tabs: () => null,
  Timeline: ({ items }: { items: Array<{ key: string; children: ReactNode }> }) => <div>{items.map(item => <div key={item.key}>{item.children}</div>)}</div>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
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
  it('pending sales groups can be accepted as one stable group request', async () => {
    invoke.mockImplementation(async channel => channel === C.ASSIGNMENT_GROUPS ? { ok: true, data: { items: [{ groupId: 'group-a', total: 50, pending: 50, accepted: 0, rejected: 0, cancelled: 0, actorName: '管理员', targetName: '用户甲', createdAt: '2026-10-14', contactNames: ['Alice','Bob'], companyNames: ['Fixture Company'], canAcceptAll: true, canRejectAll: true, canCancelAll: false }], total: 1 } } : { ok: false, error: { code: 'UNAVAILABLE', message: '响应丢失' } });
    await mount(<ContactAssignments operations={false} />);
    expect(host.textContent).toContain('50 个联系人'); expect(host.textContent).toContain('Alice、Bob'); expect(host.textContent).toContain('待接受 50'); expect(host.textContent).toContain('拒绝');
    const button = Array.from(host.querySelectorAll('button')).find(button => button.textContent === '一键接收')!;
    await act(async () => button.click()); await act(async () => button.click());
    const writes = invoke.mock.calls.filter(call => call[0] === C.ASSIGNMENT_GROUP_ACCEPT); expect(writes).toHaveLength(2); expect(writes[0]![1]).toEqual(writes[1]![1]); expect(writes[0]![1]).toMatchObject({ groupId: 'group-a' });
    expect(invoke.mock.calls.every(call => [C.ASSIGNMENT_GROUPS, C.ASSIGNMENT_GROUP_ACCEPT].includes(call[0]))).toBe(true);
  });
  it('opens one assignment group and keeps per-contact actions available inside', async () => {
    invoke.mockImplementation(async channel => channel === C.ASSIGNMENT_GROUPS ? { ok: true, data: { items: [{ groupId: 'group-a', total: 2, pending: 2, accepted: 0, rejected: 0, cancelled: 0, actorName: '管理员', targetName: '用户甲', createdAt: '2026-10-14', contactNames: ['Alice','Bob'], companyNames: ['Fixture Company'], canAcceptAll: true, canRejectAll: true, canCancelAll: false }], total: 1 } } : channel === C.ASSIGNMENT_LIST ? { ok: true, data: { items: [{ requestId: 'request-a', groupId: 'group-a', contactId: 9, customerId: 'customer-a', version: 1, contactName: 'Alice', companyName: 'Fixture Company', targetName: '用户甲', actorName: '管理员', createdAt: '2026-10-14', status: 'pending', canAccept: true, canReject: true, canCancel: false }], total: 1 } } : { ok: false, error: { code: 'UNAVAILABLE', message: '响应丢失' } });
    await mount(<ContactAssignments operations={false} />);
    await act(async () => host.querySelector<HTMLButtonElement>('.assignment-group-main')!.click()); await act(flush);
    expect(invoke).toHaveBeenCalledWith(C.ASSIGNMENT_LIST, expect.objectContaining({ groupId: 'group-a', limit: 200, offset: 0 }));
    expect(host.textContent).toContain('Alice');expect(host.textContent).toContain('接受');expect(host.textContent).toContain('返回分组');
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
  it('renders every lifecycle filter and keeps expired assignments read-only', async () => {
    window.location.hash = '#/customers?view=assignments&requestId=expired-a&assignmentStatus=expired';
    invoke.mockImplementation(async channel => channel === C.ASSIGNMENT_LIST ? { ok: true, data: { items: [{
      requestId: 'expired-a', groupId: 'group-a', contactId: 9, customerId: 'customer-a', version: 3,
      contactName: 'Expired contact', email: 'expired@example.invalid', companyName: 'Fixture Company',
      targetUserId: 'owner-a', targetName: 'Owner A', actorId: 'ops-a', actorName: '管理员',
      supervisorUserIds: [], sourceOrgUnitId: null, sourceOrgUnitName: null, previousTargetUserId: null,
      transferActorId: null, transferRequestedAt: null, status: 'expired', createdAt: '2026-10-01T00:00:00.000Z',
      expiresAt: '2026-10-08T00:00:00.000Z', decidedAt: null, canAccept: false, canReject: false, canCancel: false, canTransfer: false,
    }], total: 1 } } : { ok: false, error: { code: 'UNAVAILABLE', message: 'unexpected call' } });
    await mount(<ContactAssignments operations={false} />);
    expect(host.textContent).toContain('待接受');
    expect(host.textContent).toContain('转交待确认');
    expect(host.textContent).toContain('已过期');
    expect(host.textContent).toContain('已于');
    expect(host.textContent).toContain('只读');
    const actionLabels = Array.from(host.querySelectorAll('button')).map(button => button.textContent);
    expect(actionLabels).not.toContain('接受');
    expect(actionLabels).not.toContain('拒绝');
    expect(actionLabels).not.toContain('撤回');
    expect(actionLabels).not.toContain('转交');
    expect(actionLabels).not.toContain('跟进');
  });
  it('shows pending transfer labels and a concise remaining time', async () => {
    window.location.hash = '#/customers?view=assignments&requestId=transfer-a&assignmentStatus=pending_transfer';
    invoke.mockImplementation(async channel => channel === C.ASSIGNMENT_LIST ? { ok: true, data: { items: [{
      requestId: 'transfer-a', groupId: 'group-a', contactId: 9, customerId: 'customer-a', version: 4,
      contactName: 'Transfer contact', email: null, companyName: 'Fixture Company', targetUserId: 'sales-a', targetName: 'Sales A',
      actorId: 'owner-a', actorName: 'Owner A', supervisorUserIds: ['leader-a'], sourceOrgUnitId: null, sourceOrgUnitName: null,
      previousTargetUserId: 'owner-a', transferActorId: 'owner-a', transferRequestedAt: new Date().toISOString(), status: 'pending_transfer',
      createdAt: '2026-10-01T00:00:00.000Z', expiresAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(), decidedAt: null,
      canAccept: true, canReject: true, canCancel: true, canTransfer: false,
    }], total: 1 } } : { ok: false, error: { code: 'UNAVAILABLE', message: 'unexpected call' } });
    await mount(<ContactAssignments operations={false} />);
    expect(host.textContent).toContain('转交待确认');
    expect(host.textContent).toContain('剩余 2 天');
    const actionLabels = Array.from(host.querySelectorAll('button')).map(button => button.textContent);
    expect(actionLabels).toContain('接受');
    expect(actionLabels).toContain('拒绝');
    expect(actionLabels).toContain('撤回');
    expect(actionLabels).not.toContain('转交');
    expect(actionLabels).not.toContain('跟进');
  });
  it('confirms a transfer with the accepted version and reuses its idempotency key after an unknown result', async () => {
    const assignment = {
      requestId: 'request-transfer', groupId: 'group-a', contactId: 17, customerId: 'customer-a', version: 6,
      contactName: 'Synthetic', email: null, companyName: 'Fixture Company', targetUserId: 'sales-a', targetName: 'Sales A',
      actorId: 'manager-a', actorName: '管理员', supervisorUserIds: [], sourceOrgUnitId: null, sourceOrgUnitName: null,
      previousTargetUserId: null, transferActorId: null, transferRequestedAt: null, status: 'accepted',
      createdAt: '2026-10-01T00:00:00.000Z', expiresAt: '2026-10-08T00:00:00.000Z', decidedAt: '2026-10-01T01:00:00.000Z',
      canAccept: false, canReject: false, canCancel: false, canTransfer: true,
    } as ContactAssignment;
    invoke.mockImplementation(async channel => channel === C.MEMBERS
      ? { ok: true, data: { items: [{ userId: 'sales-a', displayName: 'Sales A', assignable: true }, { userId: 'sales-b', displayName: 'Sales B', assignable: true }], total: 2 } }
      : { ok: false, error: { code: 'UNAVAILABLE', message: '响应丢失' } });
    await mount(<AssignmentTransferModal assignment={assignment} close={() => {}} />);
    const selector = host.querySelector<HTMLSelectElement>('[aria-label="转交接收人"]')!;
    expect(selector.textContent).not.toContain('Sales A');
    await act(async () => { selector.value = 'sales-b'; selector.dispatchEvent(new Event('change', { bubbles: true })); });
    const confirm = Array.from(host.querySelectorAll('button')).find(button => button.textContent === '确认转交')!;
    await act(async () => confirm.click());
    await act(async () => confirm.click());
    const writes = invoke.mock.calls.filter(call => call[0] === C.ASSIGNMENT_TRANSFER);
    expect(writes).toHaveLength(2);
    expect(writes[0]![1]).toEqual(writes[1]![1]);
    expect(writes[0]![1]).toMatchObject({ requestId: 'request-transfer', targetUserId: 'sales-b', expectedVersion: 6 });
    expect(writes[0]![1]).not.toHaveProperty('notifyUserIds');
  });
  it('opens monitor deep links through the customer page with an explicit customer reference', async () => {
    const customerId = '11111111-1111-4111-8111-111111111111';
    invoke.mockImplementation(async channel => channel === C.CONTACT_MONITOR_DETAIL ? { ok: true, data: {
      auditId: 'audit-a', accessedAt: '2026-10-29T00:00:00.000Z', relationship: 'direct_leader',
      contact: { contactId: 27, customerId, companyId: 7, companyName: 'Fixture Company', email: 'fixture@example.invalid', firstName: 'Monitor', lastName: 'Contact', title: 'Buyer', phone: '123', whatsapp: null, country: 'US', clientType: 'agent', language: 'en', stage: 'reaching', status: 'active', tags: [], touchStatus: 'replied', source: 'operations', sourceDetail: 'Batch A', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-29T00:00:00.000Z', ownerUserId: 'sales-a', ownerName: 'Owner A', origin: 'operations' },
      company: { contactId: 27, customerId, companyId: 7, name: 'Fixture Company', domain: 'fixture.invalid', country: 'US' },
      activities: [{ id: 'activity-a', actorId: 'sales-a', actorName: 'Owner A', note: 'Called customer', stage: 'reaching', createdAt: '2026-10-28T00:00:00.000Z', occurredAt: '2026-10-28T00:00:00.000Z', recordedAt: '2026-10-28T00:00:00.000Z', contactStatus: 'replied' }],
      mailEvents: [{ eventId: 'mail-a', actorId: 'sales-a', mailboxKey: 'mailbox-a', messageKey: 'message-a', kind: 'received', direction: 'inbound', occurredAt: '2026-10-27T00:00:00.000Z', recordedAt: '2026-10-27T00:00:00.000Z', subject: 'Quote request', preview: 'Please quote this route', fromEmail: 'customer@example.invalid', toEmails: ['owner@example.invalid'], ccEmails: [], contactId: 27, customerId, eventKey: 'mail-a', activityId: null, contentHash: 'a'.repeat(64) }],
      mailEventLimit: 100,
    } } : channel === C.CONTACT_MAIL_ANALYSIS ? { ok: true, data: {
      current: { contactId: 27, customerId, mailboxKey: 'mailbox-a', messageKey: 'message-a', contentHash: 'a'.repeat(64), analysisId: 'analysis-a', actorId: 'sales-a', eventId: 'mail-a', threadKey: 'quote-request', analyzerVersion: 'fixture-v1', inputSequence: 10, source: 'ai', relevance: 'customer_business', classification: 'replied', contactState: 'replied', summary: '客户询价 2×40HQ', signals: [{ code: 'quote_request', label: '报价请求', confidence: 0.94, evidence: '2×40HQ' }], requiresAction: true, nextAction: '回复报价', priority: 'important', dueHint: '24 小时内', confidence: 0.94, evidence: ['2×40HQ'], humanLocked: false, supersedesId: null, isCurrent: true, createdAt: '2026-10-27T00:00:01.000Z' },
      history: [], canCorrect: false, access: 'monitor', taskSuggestion: { key: 'task-a', actionCode: 'quote_request', nextAction: '回复报价', priority: 'important', dueHint: '24 小时内' },
    } } : channel === C.CONTACT_MAIL_ANALYSIS_QUEUE ? { ok: true, data: { enabled: true, pending: 0, running: 0, retrying: 0, completed: 1, failed: 0, lastError: null } }
      : { ok: false, error: { code: 'UNAVAILABLE', message: 'unexpected call' } });
    window.location.hash = `#/customers?view=board&monitorContact=27&centerCustomer=${customerId}`;
    await mount(<LegacyCustomersPage />);
    expect(invoke).toHaveBeenCalledWith(C.CONTACT_MONITOR_DETAIL, { contactId: 27, customerId });
    expect(invoke.mock.calls.some(call => call[0] === C.CONTACT_DETAIL)).toBe(false);
    expect(host.textContent).toContain('Fixture Company');
    expect(host.textContent).toContain('Owner A');
    expect(host.textContent).toContain('Quote request');
    expect(host.textContent).toContain('客户询价 2×40HQ');
    expect(host.textContent).toContain('报价请求');
    expect(host.querySelector('[aria-label="删除联系人"]')).toBeNull();
    expect(host.querySelector('[aria-label="共享线索"]')).toBeNull();
    expect(host.querySelector('button[aria-label="关闭监督详情"]')).not.toBeNull();
    const forbidden = Array.from(host.querySelectorAll('button')).map(button => button.textContent).filter(Boolean);
    expect(forbidden).not.toContain('编辑');
    expect(forbidden).not.toContain('跟进');
    expect(forbidden).not.toContain('发送');
    expect(forbidden).not.toContain('删除');
    expect(forbidden).not.toContain('导出');
    expect(forbidden).not.toContain('修正');
    expect(forbidden).not.toContain('保存修正');
  });
});
