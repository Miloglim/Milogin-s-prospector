// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkbookImportPanel } from '../../src/renderer/pages/customers/WorkbookImportPanel';
import { CustomersPage } from '../../src/renderer/pages/customers/CustomersPage';
import { ONLINE_CHANNELS as CHANNEL } from '../../src/shared/online-crm';
import type { WorkbookImportRequest } from '../../src/shared/online-crm';

vi.mock('../../src/renderer/IdentityContext', () => ({ useOptionalIdentity: () => ({ identity: { userId: 'synthetic', crmRoles: ['sales'], crmCapabilities: ['leads.create', 'leads.develop'] }, refresh: vi.fn() }) }));
const preview = { fileName: 'synthetic.xlsx', headers: [], rows: [], sheets: [
  { sheetName: '客户管理', headers: ['id', '公司名称'], rows: [{ id: 'a', 公司名称: '无邮箱公司' }, { id: 'b', 公司名称: '' }], rowNumbers: [2, 5] },
  { sheetName: '联系人管理', headers: ['id', '客户ID', '姓名', '邮箱'], rows: [{ id: 'contact-a', 客户ID: 'a', 姓名: '电话联系人', 邮箱: '' }, { id: 'contact-b', 客户ID: 'b', 姓名: '待核对联系人', 邮箱: '' }], rowNumbers: [3, 9] },
  { sheetName: '客户待上传', headers: ['id'], rows: [{ id: 'ignored' }], rowNumbers: [2] },
] };
const receipt = (request: WorkbookImportRequest, status = 'created') => ({ ok: true, data: { batchId: request.idempotencyKey, rows: request.rows.map((row, index) => ({ rowId: `${request.idempotencyKey}:${index}`, index, entity: row.entity, sheetName: row.sheetName, rowNumber: row.rowNumber, status, customerId: 'synthetic-customer' })) } });

describe('B1 customer workbook renderer', () => {
  let host: HTMLDivElement; let root: Root; let invoke: ReturnType<typeof vi.fn>; let imported: ReturnType<typeof vi.fn>; let failure: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
    imported = vi.fn(); failure = vi.fn(); invoke = vi.fn(async (channel, request) => channel === CHANNEL.WORKBOOK_PREVIEW ? { ok: true, data: preview } : receipt(request));
    Object.defineProperty(window, 'api', { configurable: true, value: { invoke } });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
  const mount = async () => act(async () => { root.render(<WorkbookImportPanel source="Synthetic source" sourceDetail="" kind="operations" onImported={imported} onLocked={() => undefined} onFailure={failure} />); });
  const click = async (text: string) => act(async () => { Array.from(document.querySelectorAll('button')).find(button => button.textContent?.replace(/\s/g, '') === text)!.click(); });
  const confirm = async () => act(async () => { document.querySelector<HTMLInputElement>('.workbook-import-panel input[type="checkbox"]')!.click(); });
  it('keeps every selected row and explicit unselected sheets, including customers and contacts without email', async () => {
    await mount(); await click('选择工作簿');
    expect(host.textContent).toContain('2 个客户'); expect(host.textContent).toContain('2 位联系人');
    expect(host.textContent).toContain('客户待上传（1 行）'); expect(host.textContent).toContain('客户管理 · 5'); expect(host.textContent).toContain('联系人管理 · 9');
    expect(host.textContent).toContain('无邮箱公司'); expect(host.textContent).toContain('电话联系人'); expect(host.textContent).toContain('—');
    expect(invoke.mock.calls.filter(call => call[0] === CHANNEL.WORKBOOK_IMPORT)).toHaveLength(0);
  });
  it('submits valid customer rows first and only attaches contacts whose customer succeeded', async () => {
    await mount(); await click('选择工作簿'); await confirm(); await click('导入已确认行');
    const calls = invoke.mock.calls.filter(call => call[0] === CHANNEL.WORKBOOK_IMPORT);
    expect(calls).toHaveLength(2); expect(calls[0][1].rows.map((row: { entity: string }) => row.entity)).toEqual(['customer']);
    expect(calls[1][1].rows.map((row: { entity: string }) => row.entity)).toEqual(['contact']);
    expect(calls[1][1].rows[0]).toMatchObject({ customerRef: 'a', name: '电话联系人' }); expect(calls[1][1].rows[0].email).toBeUndefined();
    expect(host.textContent).toContain('待处理 2 行'); expect(host.textContent).toContain('联系人管理 · 9'); expect(imported).toHaveBeenCalledTimes(2);
  });
  it('retains the exact unknown request and never sends contacts after a failed customer receipt', async () => {
    let writes = 0;
    invoke.mockImplementation(async (channel, request) => {
      if (channel === CHANNEL.WORKBOOK_PREVIEW) return { ok: true, data: preview };
      writes++; return writes === 1 ? { ok: false, error: { code: 'UNAVAILABLE', message: 'Response lost' } } : receipt(request, 'invalid');
    });
    await mount(); await click('选择工作簿'); await confirm(); await click('导入已确认行');
    expect(host.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
    await click('重试未完成批次');
    const calls = invoke.mock.calls.filter(call => call[0] === CHANNEL.WORKBOOK_IMPORT);
    expect(calls).toHaveLength(2); expect(calls[0][1]).toEqual(calls[1][1]); expect(calls[1][1].rows[0].entity).toBe('customer');
    expect(host.textContent).toContain('待处理 4 行'); expect(host.textContent).toContain('需修正');
  });
  it('does not treat a partial receipt as completed and retries its original command', async () => {
    let writes = 0;
    invoke.mockImplementation(async (channel, request) => {
      if (channel === CHANNEL.WORKBOOK_PREVIEW) return { ok: true, data: preview };
      writes++; return writes === 1 ? { ok: true, data: { batchId: 'partial', rows: [] } } : receipt(request);
    });
    await mount(); await click('选择工作簿'); await confirm(); await click('导入已确认行');
    expect(host.textContent).toContain('导入回执不完整'); expect(host.textContent).toContain('待处理 4 行');
    await click('重试未完成批次');
    const calls = invoke.mock.calls.filter(call => call[0] === CHANNEL.WORKBOOK_IMPORT); expect(calls[0][1]).toEqual(calls[1][1]);
    expect(host.textContent).toContain('待处理 2 行');
  });
  it('retries an unknown contact batch once and leaves a known invalid receipt pending for correction', async () => {
    let writes = 0;
    invoke.mockImplementation(async (channel, request) => {
      if (channel === CHANNEL.WORKBOOK_PREVIEW) return { ok: true, data: preview };
      writes++; return writes === 2 ? { ok: false, error: { code: 'UNAVAILABLE', message: 'Contact response lost' } } : receipt(request, writes === 3 ? 'invalid' : 'created');
    });
    await mount(); await click('选择工作簿'); await confirm(); await click('导入已确认行'); await click('重试未完成批次');
    const calls = invoke.mock.calls.filter(call => call[0] === CHANNEL.WORKBOOK_IMPORT);
    expect(calls).toHaveLength(3); expect(calls[1][1]).toEqual(calls[2][1]); expect(calls[2][1].rows[0].entity).toBe('contact'); expect(host.textContent).toContain('待处理 3 行');
  });
  it('does not merge duplicate company names without source IDs or guess their contact ownership', async () => {
    invoke.mockImplementation(async channel => ({ ok: true, data: channel === CHANNEL.WORKBOOK_PREVIEW ? { ...preview, sheets: [
      { sheetName: '客户管理', headers: ['公司名称'], rows: [{ 公司名称: 'Same company' }, { 公司名称: 'Same company' }], rowNumbers: [2, 7] },
      { sheetName: '联系人管理', headers: ['id', '公司名称', '姓名'], rows: [{ id: 'contact', 公司名称: 'Same company', 姓名: 'Uncertain owner' }], rowNumbers: [12] },
    ] } : undefined }));
    await mount(); await click('选择工作簿'); await confirm();
    expect(host.textContent).toContain('来源引用重复'); expect(host.textContent).toContain('所属客户未关联'); expect(host.textContent).toContain('待处理 3 行');
    expect(Array.from(host.querySelectorAll('button')).find(button => button.textContent === '导入已确认行')!.disabled).toBe(true);
    expect(invoke.mock.calls.some(call => call[0] === CHANNEL.WORKBOOK_IMPORT)).toBe(false);
  });
  it('keeps an unknown cooperation category pending until explicit source-only confirmation', async () => {
    invoke.mockImplementation(async (channel, request) => channel === CHANNEL.WORKBOOK_PREVIEW ? { ok: true, data: { ...preview, sheets: [
      { sheetName: '客户管理', headers: ['id', '公司名称', '业务类型'], rows: [{ id: 'a', 公司名称: 'Cooperation source', 业务类型: '已合作' }], rowNumbers: [2] },
    ] } } : receipt(request));
    await mount(); await click('选择工作簿'); expect(host.textContent).toContain('关系状态待确认'); await click('修正');
    expect(Array.from(host.querySelectorAll('button')).find(button => button.textContent === '保存修正')!.disabled).toBe(true);
    await act(async () => { Array.from(host.querySelectorAll('label')).find(label => label.textContent === '保留来源原文，暂不设置客户关系阶段')!.click(); });
    await click('保存修正'); await confirm(); await click('导入已确认行');
    const request = invoke.mock.calls.find(call => call[0] === CHANNEL.WORKBOOK_IMPORT)![1]; expect(request.rows[0].rawRow.业务类型).toBe('已合作'); expect(request.rows[0].stage).toBeUndefined(); expect(request.rows[0].businessType).toBeUndefined();
  });
  it('ignores a file-picker response after the panel unmounts', async () => {
    let resolve!: (value: unknown) => void; invoke.mockImplementation(() => new Promise(done => { resolve = done; }));
    await mount(); await click('选择工作簿'); await act(async () => root.render(<div>Different identity</div>));
    await act(async () => resolve({ ok: true, data: preview })); expect(host.textContent).toBe('Different identity'); expect(imported).not.toHaveBeenCalled();
  });
  it('ignores an in-flight import result after the panel unmounts and does not continue to contacts', async () => {
    let resolve!: (value: unknown) => void; let pending!: WorkbookImportRequest;
    invoke.mockImplementation(async (channel, request) => channel === CHANNEL.WORKBOOK_PREVIEW ? { ok: true, data: preview } : new Promise(done => { resolve = done; pending = request; }));
    await mount(); await click('选择工作簿'); await confirm(); await click('导入已确认行');
    await act(async () => root.render(<div>New identity</div>)); await act(async () => resolve(receipt(pending)));
    expect(imported).not.toHaveBeenCalled(); expect(invoke.mock.calls.filter(call => call[0] === CHANNEL.WORKBOOK_IMPORT)).toHaveLength(1); expect(host.textContent).toBe('New identity');
  });
  it.each([null, {}, { batchId: 'malformed', rows: 'not-an-array' }, { batchId: 'malformed', rows: [null] }])('keeps a malformed successful response pending without throwing (%j)', async malformed => {
    let writes = 0;
    invoke.mockImplementation(async (channel, request) => {
      if (channel === CHANNEL.WORKBOOK_PREVIEW) return { ok: true, data: preview };
      writes++; return writes === 1 ? { ok: true, data: malformed } : receipt(request);
    });
    await mount(); await click('选择工作簿'); await confirm(); await click('导入已确认行'); expect(host.textContent).toContain('导入回执不完整');
    await click('重试未完成批次'); const calls = invoke.mock.calls.filter(call => call[0] === CHANNEL.WORKBOOK_IMPORT); expect(calls[0][1]).toEqual(calls[1][1]); expect(host.textContent).toContain('待处理 2 行');
  });
  it.each(['INVALID_INPUT', 'PAYLOAD_TOO_LARGE'])('unlocks a known pre-write rejection for explicit correction and a fresh key (%s)', async code => {
    let writes = 0;
    invoke.mockImplementation(async (channel, request) => {
      if (channel === CHANNEL.WORKBOOK_PREVIEW) return { ok: true, data: preview };
      writes++; return writes === 1 ? { ok: false, error: { code, message: 'Source field rejected' } } : receipt(request);
    });
    await mount(); await click('选择工作簿'); await confirm(); await click('导入已确认行');
    expect(host.textContent).toContain('Source field rejected'); expect(host.textContent).not.toContain('重试未完成批次'); await click('修正');
    await act(async () => { const input = host.querySelector<HTMLInputElement>('[aria-label="工作簿修正公司名称"]')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Corrected company'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await click('保存修正'); await confirm(); await click('导入已确认行');
    const calls = invoke.mock.calls.filter(call => call[0] === CHANNEL.WORKBOOK_IMPORT); expect(calls[1][1].idempotencyKey).not.toBe(calls[0][1].idempotencyKey); expect(calls[1][1].rows[0].companyName).toBe('Corrected company');
  });
  it('allows creating a customer with zero contacts and displays a phone-only contact without a fake email', async () => {
    const customer = { customerId: 'synthetic', companyName: 'Phone Company', country: '', source: 'Synthetic', sourceDetail: '', version: 1, state: 'owned', origin: 'personal', contactCount: 1, ownerUserId: 'synthetic', contacts: [{ contactId: 1, name: 'Phone person', email: null, phone: '123' }], activities: [] };
    invoke.mockImplementation(async channel => ({ ok: true, data: channel === CHANNEL.BOOTSTRAP ? { userId: 'synthetic', capabilities: ['leads.create', 'leads.develop'], scope: 'own', summary: { mine: 1, pool: 0 }, feedCursor: '0' } : channel === CHANNEL.LIST ? { items: [customer], total: 1 } : customer }));
    await act(async () => { root.render(<CustomersPage />); }); await act(async()=>{const create=Array.from(host.querySelectorAll<HTMLButtonElement>('.customer-legacy-toolbar button')).find(button=>/^新增(?:客户)?$/.test(button.textContent?.replace(/\s/g,'')??''));expect(create).toBeDefined();create!.click();}); await click('移除联系人');
    await act(async () => { const input = document.querySelector<HTMLInputElement>('#companyName')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'No Contacts'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await click('保存'); const writes = invoke.mock.calls.filter(call => call[0] === CHANNEL.CREATE_CUSTOMER); expect(writes).toHaveLength(1); expect(writes[0][1].contacts).toEqual([]);
    expect(document.body.textContent).toContain('Phone person'); expect(document.body.textContent).not.toMatch(/@/); expect(document.body.textContent).toContain('—');
  });
});
