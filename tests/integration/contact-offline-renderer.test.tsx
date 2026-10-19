// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CenterContactDetail } from '../../src/renderer/pages/customers/CenterContactDetail';
import { CrmSyncPanel } from '../../src/renderer/pages/customers/CrmSyncPanel';
import { ONLINE_CHANNELS } from '../../src/shared/online-crm';
import { message } from 'antd';
import { useCenterContacts } from '../../src/renderer/hooks/useCenterContacts';
const identity = vi.hoisted(() => ({ identity: { userId: 'fixture', crmRoles: ['sales'], crmCapabilities: [] as string[] }, baseUrl: 'http://fixture.invalid', status: 'offline' }));
vi.mock('../../src/renderer/IdentityContext', () => ({ useIdentity: () => identity }));
vi.mock('../../src/renderer/components/ContactDetail', async original => ({
  ...await original<typeof import('../../src/renderer/components/ContactDetail')>(),
  ContactDetailLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  InfoTab: ({ canEdit, onSaveField }: { canEdit: boolean; onSaveField: (field: string, value: string) => void }) => <button disabled={!canEdit} onClick={() => onSaveField('title', 'Buyer')}>edit title</button>,
}));
const reference = { contactId: 42, customerId: 'customer-42' };
const fixture = () => ({ contact: { ...reference, contactVersion: 7, companyId: 9, email: 'fixture@example.invalid', firstName: 'Fixture', tags: [], extra: {}, touchStatus: 'uncontacted', status: '' }, company: { companyId: 9, name: 'Fixture', canEdit: true }, permissions: { editableFields: ['title'], canFollowup: true, canChangeStage: false, canShare: true }, activities: [], canEdit: true, canFollowup: true, canDelete: true, mailAvailable: true, localSync: { pending: 1, state: 'pending' } });
describe('contact offline integration', () => {
  let root: Root, host: HTMLDivElement, client: QueryClient, invoke: ReturnType<typeof vi.fn>;
  const flush = () => new Promise(resolve => setTimeout(resolve, 40));
  beforeEach(() => {
    identity.status = 'offline'; identity.identity.userId = 'fixture'; identity.identity.crmRoles = ['sales']; identity.identity.crmCapabilities = [];
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
    invoke = vi.fn(async () => ({ ok: true, data: fixture() }));
    Object.defineProperty(window, 'api', { configurable: true, value: { invoke } });
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); vi.restoreAllMocks(); });
  async function render() { await act(async () => root.render(<QueryClientProvider client={client}><CenterContactDetail reference={reference} onClose={() => {}} /></QueryClientProvider>)); await act(flush); }
  it('allows cached permitted edits offline while destructive and share actions stay unavailable', async () => {
    await render(); const edit = Array.from(host.querySelectorAll('button')).find(x => x.textContent === 'edit title')!;
    expect(edit.disabled).toBe(false);
    await act(async () => { edit.click(); await flush(); });
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.CONTACT_UPDATE, expect.objectContaining({ fields: { title: 'Buyer' } }));
    expect(host.textContent).not.toContain('待同步');
    expect(host.querySelector<HTMLButtonElement>('[aria-label="删除联系人"]')?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('[aria-label="共享线索"]')?.disabled).toBe(true);
  });
  it('ignores a late save after switching accounts', async () => {
    let finish!: (value: unknown) => void;
    invoke.mockImplementation(async (channel: string) => channel === ONLINE_CHANNELS.CONTACT_UPDATE ? new Promise(resolve => { finish = resolve; }) : { ok: true, data: fixture() });
    await render(); await act(async () => { Array.from(host.querySelectorAll('button')).find(x => x.textContent === 'edit title')!.click(); await flush(); });
    identity.identity.userId = 'other'; await render();
    await act(async () => { finish({ ok: true, data: { ...fixture(), contact: { ...fixture().contact, firstName: 'Wrong account' } } }); await flush(); });
    expect(host.textContent).not.toContain('Wrong account');
    expect(client.getQueriesData({ queryKey: ['center-contact-detail', identity.baseUrl, 'fixture', reference.customerId, reference.contactId] })[0]?.[1]).toMatchObject({ data: { contact: { firstName: 'Fixture' } } });
  });
  it.each(['FORBIDDEN', 'NOT_FOUND'])('does not revive a %s detail from a late successful save', async code => {
    let finish!: (value: unknown) => void;
    let denied = false;
    invoke.mockImplementation(async (channel: string) => channel === ONLINE_CHANNELS.CONTACT_UPDATE
      ? new Promise(resolve => { finish = resolve; })
      : denied ? { ok: false, error: { code, message: '当前不可访问' } } : { ok: true, data: fixture() });
    await render();
    await act(async () => { Array.from(host.querySelectorAll('button')).find(x => x.textContent === 'edit title')!.click(); await flush(); });
    denied = true;
    await act(async () => { await client.invalidateQueries({ queryKey: ['center-contact-detail'] }); await flush(); });
    expect(host.textContent).not.toContain('fixture@example.invalid');
    await act(async () => { finish({ ok: true, data: fixture() }); await flush(); });
    expect(host.textContent).not.toContain('fixture@example.invalid');
    expect(host.textContent).not.toContain('edit title');
  });
  it('does not revive removed field permission from an in-flight save', async () => {
    let finish!: (value: unknown) => void;
    let writable = true;
    invoke.mockImplementation(async (channel: string) => channel === ONLINE_CHANNELS.CONTACT_UPDATE
      ? new Promise(resolve => { finish = resolve; })
      : { ok: true, data: writable ? fixture() : { ...fixture(), canEdit: false, canFollowup: false, permissions: { ...fixture().permissions, editableFields: [], canFollowup: false } } });
    await render();
    await act(async () => { Array.from(host.querySelectorAll('button')).find(x => x.textContent === 'edit title')!.click(); await flush(); });
    writable = false;
    await act(async () => { await client.invalidateQueries({ queryKey: ['center-contact-detail'] }); await flush(); });
    await act(async () => { finish({ ok: true, data: fixture() }); await flush(); });
    expect(Array.from(host.querySelectorAll('button')).find(x => x.textContent === 'edit title')!.disabled).toBe(true);
  });
  it('retains the mounted editor through a transient detail failure', async () => {
    await render();
    const editor = Array.from(host.querySelectorAll('button')).find(x => x.textContent === 'edit title')!;
    invoke.mockResolvedValue({ ok: false, error: { code: 'UNAVAILABLE', message: '连接中断' } });
    await act(async () => { await client.invalidateQueries({ queryKey: ['center-contact-detail'] }); await flush(); });
    expect(host.textContent).toContain('连接中断');
    expect(Array.from(host.querySelectorAll('button')).find(x => x.textContent === 'edit title')).toBe(editor);
  });
  it('does not display a cached privileged detail after a same-account role downgrade before the fresh read finishes', async () => {
    identity.identity.crmRoles = ['admin'];
    await render();
    expect(host.textContent).toContain('fixture@example.invalid');
    identity.identity.crmRoles = ['sales'];
    invoke.mockImplementation(() => new Promise(() => {}));
    await render();
    expect(host.textContent).not.toContain('fixture@example.invalid');
    expect(host.textContent).not.toContain('edit title');
  });
  it('does not reuse privileged contact-list cache or placeholder rows after a same-account role downgrade', async () => {
    function ListProbe() { const query = useCenterContacts({}); return <div>{query.data?.ok ? query.data.data.items.map(row => row.email).join(',') : 'loading'}</div>; }
    const mount = async () => { await act(async () => root.render(<QueryClientProvider client={client}><ListProbe /></QueryClientProvider>)); await act(flush); };
    identity.identity.crmRoles = ['admin'];
    invoke.mockResolvedValue({ ok: true, data: { total: 1, items: [{ ...fixture().contact, customerId: '00000000-0000-0000-0000-000000000042', customerVersion: 7, companyName: 'Fixture', updatedAt: '2026-10-16T00:00:00Z' }] } });
    await mount();
    expect(host.textContent).toContain('fixture@example.invalid');
    identity.identity.crmRoles = ['sales'];
    invoke.mockImplementation(() => new Promise(() => {}));
    await mount();
    expect(host.textContent).not.toContain('fixture@example.invalid');
  });
  it.each(['conflict','failed'])('keeps %s as an internal sync state without adding UI copy', async state => {
    invoke.mockResolvedValue({ok:true,data:{...fixture(),localSync:{pending:1,state,message:'需处理'}}});
    await render();expect(host.textContent).not.toContain('同步冲突');expect(host.textContent).not.toContain('同步失败');
  });
  it.each([true, false])('retains followup until persisted and reports queued=%s honestly', async queued => {
    const success = vi.spyOn(message, 'success').mockImplementation(() => (() => {}) as ReturnType<typeof message.success>);
    invoke.mockImplementation(async (channel: string) => channel === ONLINE_CHANNELS.CONTACT_FOLLOWUP && !queued ? { ok: false, error: { code: 'LOCAL_ERROR', message: '本地保存失败' } } : { ok: true, data: fixture() });
    await render();
    await act(async () => { (Array.from(host.querySelectorAll('[role="tab"]')).find(x => x.textContent === '往来记录') as HTMLElement).click(); await flush(); });
    const note = host.querySelector('textarea')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(note, 'My draft'); note.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { await client.invalidateQueries({ queryKey: ['center-contact-detail'] }); await flush(); });
    expect(host.querySelector('textarea')?.value).toBe('My draft');
    const button = host.querySelector<HTMLButtonElement>('.ant-tabs-tabpane-active .ant-btn-primary')!;
    expect(button.disabled).toBe(false);
    await act(async () => { button.click(); await flush(); });
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.CONTACT_FOLLOWUP, expect.objectContaining({ note: 'My draft' }));
    if (queued) { expect(success).toHaveBeenCalledWith('已保存'); expect(host.querySelector('textarea')?.value).toBe(''); }
    else { expect(success).not.toHaveBeenCalled(); expect(host.querySelector('textarea')?.value).toBe('My draft'); }
    success.mockRestore();
  });
  it('shows exact contact field comparison and prohibits discarding uncertain replay-only commands', async () => {
    invoke.mockResolvedValue({ ok: true, data: { connection: 'online', syncing: false, pending: 1, failed: 1, conflicts: 0, issues: [{ id: 'command-1', status: 'failed', message: '结果待确认', replayOnly: true, contact: { ...reference, name: 'Fixture contact', action: 'update', fields: { title: 'Buyer' }, centralFields: { title: 'Director' } } }] } });
    await act(async () => root.render(<CrmSyncPanel onChanged={() => {}} />)); await act(flush);
    await act(async () => { Array.from(host.querySelectorAll('button')).find(x => x.textContent === '同步详情')!.click(); await flush(); });
    expect(document.body.textContent).toContain('Fixture contact'); expect(document.body.textContent).toContain('职位：Buyer'); expect(document.body.textContent).toContain('职位：Director');
    const buttons = Array.from(document.body.querySelectorAll('button'));
    expect(buttons.find(x => x.textContent === '保留中心')).toBeUndefined();
    expect(buttons.find(x => x.textContent === '重试同步')).toBeDefined();
  });
});
