// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportDrawer, type ImportDrawerPort } from '../../src/renderer/components/ImportDrawer';

describe('contact import preview editing', () => {
  let root: Root, host: HTMLDivElement;
  const flush = () => new Promise(resolve => setTimeout(resolve, 50));
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

  it('shows problem rows first, allows cell correction, and submits edited values', async () => {
    const rows = [['Good Co', 'good@example.com'], ['Bad Co', 'not-an-email']];
    const preview = { headers: ['公司', '邮箱'], previewRows: rows, rows, totalRows: rows.length, suggestedMapping: { '公司': 'companyName', '邮箱': 'email' }, duplicateEmails: [] };
    const execute = vi.fn(async () => ({ success: true, data: { imported: 2, skipped: 0 } }));
    const port = { preview: vi.fn(async () => ({ success: true, data: preview })), execute } as ImportDrawerPort;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}><ImportDrawer open onClose={() => {}} port={port} /></QueryClientProvider>));
    await act(flush);
    await act(async () => { Array.from(document.querySelectorAll<HTMLElement>('.ant-tabs-tab')).find(tab => tab.textContent === '粘贴数据')!.click(); await flush(); });
    const paste = document.querySelector<HTMLTextAreaElement>('textarea')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => { setValue.call(paste, '公司\t邮箱\nBad Co\tnot-an-email'); paste.dispatchEvent(new Event('input', { bubbles: true })); await flush(); });
    await act(async () => { Array.from(document.querySelectorAll('button')).find(button => button.textContent === '解析预览')!.click(); await flush(); });
    expect(document.body.textContent).toContain('待修正 1 条');
    const firstRow = Array.from(document.querySelectorAll<HTMLTableRowElement>('.contact-import-preview-table tbody tr')).find(row => row.querySelectorAll('td input').length >= 2)!;
    expect(firstRow.textContent).toContain('邮箱格式无效');
    const confirm = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent?.startsWith('确认导入'))!;
    expect(confirm().disabled).toBe(true);
    const rowInputs = firstRow.querySelectorAll<HTMLInputElement>('input:not([type="checkbox"])');
    const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { inputSetter.call(rowInputs[1]!, 'fixed@example.com'); rowInputs[1]!.dispatchEvent(new Event('input', { bubbles: true })); await flush(); });
    expect(document.body.textContent).not.toContain('待修正 1 条');
    const correctedFirstRow = Array.from(document.querySelectorAll<HTMLTableRowElement>('.contact-import-preview-table tbody tr')).find(row => row.querySelectorAll('td input').length >= 2)!;
    expect(correctedFirstRow.querySelector<HTMLInputElement>('td input:not([type="checkbox"])')!.value).toBe('Bad Co');
    expect(confirm().disabled).toBe(false);
    await act(async () => { confirm().click(); await flush(); });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toMatchObject({ rows: [{ '公司': 'Good Co', '邮箱': 'good@example.com' }, { '公司': 'Bad Co', '邮箱': 'fixed@example.com' }] });
    client.clear();
  });
  it('marks missing-contact rows as skipped and supports keyboard multi-select delete', async () => {
    const rows = [['Good Co', 'good@example.com'], ['No Identity Co', '']];
    const preview = { headers: ['公司', '邮箱'], previewRows: rows, rows, totalRows: rows.length, suggestedMapping: { '公司': 'companyName', '邮箱': 'email' }, duplicateEmails: [] };
    const port = { preview: vi.fn(async () => ({ success: true, data: preview })), execute: vi.fn() } as ImportDrawerPort;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}><ImportDrawer open onClose={() => {}} port={port} /></QueryClientProvider>));
    await act(flush);
    await act(async () => { Array.from(document.querySelectorAll<HTMLElement>('.ant-tabs-tab')).find(tab => tab.textContent === '粘贴数据')!.click(); await flush(); });
    const paste = document.querySelector<HTMLTextAreaElement>('textarea')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => { setValue.call(paste, '公司\t邮箱\nGood Co\tgood@example.com\nNo Identity Co\t'); paste.dispatchEvent(new Event('input', { bubbles: true })); await flush(); });
    await act(async () => { Array.from(document.querySelectorAll('button')).find(button => button.textContent === '解析预览')!.click(); await flush(); });
    expect(document.body.textContent).toContain('未填写联系人 1 条（将跳过）');
    expect(Array.from(document.querySelectorAll('button')).find(button => button.textContent?.startsWith('确认导入'))?.textContent).toContain('1 条');
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true })); await flush(); });
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })); await flush(); });
    expect(document.body.textContent).toContain('已删除 2 条');
    expect(Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent?.startsWith('确认导入'))?.disabled).toBe(true);
    client.clear();
  });
});
