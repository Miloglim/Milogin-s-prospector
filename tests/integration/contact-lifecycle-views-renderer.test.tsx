// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContactList } from '../../src/renderer/pages/contacts/ContactList';
import { CompanyPage, type CompanyDataPort } from '../../src/renderer/pages/companies/CompanyPage';
import type { ContactDataPort } from '../../src/renderer/hooks/useContacts';
vi.mock('@tanstack/react-router', () => ({ useRouterState: () => ({ pathname: '/customers', search: {} }) }));
vi.mock('../../src/renderer/components/ImportDrawer', () => ({ ImportDrawer: () => null }));
const contact = { id: 42, contactId: 42, customerId: 'customer-42', dataSource: 'center', email: 'visible@example.invalid', firstName: 'Visible', lastName: null, companyName: 'Fixture company', tags: '[]' };
describe('existing contact and company views after remote lifecycle changes', () => {
  let root: Root, host: HTMLDivElement, client: QueryClient;
  const flush = () => new Promise(resolve => setTimeout(resolve, 40));
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { vi.useRealTimers(); await act(async () => root.unmount()); client.clear(); host.remove(); });
  it('places search and a labeled more menu beside the customer tabs without a count', async () => {
    const port = { key: 'fixture', list: async () => ({ success: true, data: { items: [contact], total: 1 } }), listIds: async () => ({ success: true, data: { ids: [42] } }) } as unknown as ContactDataPort;
    function WithHeader() {
      const [target, setTarget] = useState<HTMLDivElement | null>(null);
      return <><div data-testid="customer-tabs-row"><div ref={setTarget} /></div><ContactList dataPort={port} headerActionsTarget={target} /></>;
    }
    await act(async () => root.render(<QueryClientProvider client={client}><WithHeader /></QueryClientProvider>));
    await act(flush);
    const header = host.querySelector('[data-testid="customer-tabs-row"]')!;
    expect(header.querySelector('input[placeholder="搜索邮箱、姓名、公司..."]')).not.toBeNull();
    expect(header.textContent).not.toContain('共 1 人');
    expect(header.querySelector('button[aria-label="更多操作"]')?.textContent).toContain('更多');
    expect(header.querySelector('button[aria-label="更多操作"]')?.classList.contains('ant-btn-text')).toBe(true);
    expect(host.querySelector('.customer-contacts-page button[aria-label="更多操作"]')).toBeNull();
    expect(host.querySelector('.customer-contacts-page input[placeholder="搜索邮箱、姓名、公司..."]')).toBeNull();
    await act(async () => { header.querySelector<HTMLButtonElement>('button[aria-label="更多操作"]')!.click(); await flush(); });
    expect(document.querySelector('.ant-popover')?.textContent).toContain('列设置');
    expect(document.querySelector('.ant-popover')?.textContent).toContain('导入');
  });
  it('shows the contact table without a filter row or hidden filter query', async () => {
    const list = vi.fn(async (_query: unknown) => ({ success: true, data: { items: [contact], total: 1 } }));
    const port = { key: 'fixture', list, listIds: async () => ({ success: true, data: { ids: [42] } }) } as unknown as ContactDataPort;
    await act(async () => root.render(<QueryClientProvider client={client}><ContactList dataPort={port} /></QueryClientProvider>));
    await act(flush);
    expect(host.querySelector('input[placeholder="标签"]')).toBeNull();
    expect(host.textContent).not.toContain('清除筛选');
    expect(host.querySelector('.customer-contacts-page .ant-select')).toBeNull();
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ search: '', page: 1 }));
    expect(list.mock.calls[0]?.[0]).not.toHaveProperty('touchStatus');
  });
  it('shows one compact selection toolbar without duplicate action counts', async () => {
    const port = { key: 'fixture', list: async () => ({ success: true, data: { items: [contact], total: 1 } }), listIds: async () => ({ success: true, data: { ids: [42] } }), canDelete: () => true } as unknown as ContactDataPort;
    await act(async () => root.render(<QueryClientProvider client={client}><ContactList dataPort={port} onAssign={() => {}} /></QueryClientProvider>));
    await act(flush);
    await act(async () => { (host.querySelectorAll('input[type="checkbox"]')[1] as HTMLInputElement).click(); await flush(); });
    expect(host.textContent).toContain('已选择 1 项');
    expect(host.textContent).toContain('取消选择');
    expect(host.textContent).toContain('分配线索');
    expect(host.textContent).toContain('删除');
    expect(host.textContent).not.toContain('分配线索 (1)');
    expect(host.textContent).not.toContain('删除选中 (1)');
    await act(async () => { Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === '取消选择')!.click(); await flush(); });
    expect(host.textContent).not.toContain('已选择 1 项');
  });
  it('keeps import and column controls in more operations with the existing offline limits', async () => {
    const port = { key: 'fixture', list: async () => ({ success: true, data: { items: [contact], total: 1 } }), listIds: async () => ({ success: true, data: { ids: [42] } }), export: async () => ({ success: true, data: '' }) } as unknown as ContactDataPort;
    await act(async () => root.render(<QueryClientProvider client={client}><ContactList dataPort={port} online={false} /></QueryClientProvider>));
    await act(flush);
    expect(host.querySelectorAll('button[aria-label="更多操作"]')).toHaveLength(1);
    expect(host.textContent).not.toContain('列设置');
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="更多操作"]')!.click(); await flush(); });
    const button = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('.ant-popover button')).find(item => item.textContent === label)!;
    expect(button('新增').disabled).toBe(true);
    expect(button('导入').disabled).toBe(true);
    expect(button('导出').disabled).toBe(false);
    await act(async () => { button('列设置').click(); await flush(); });
    expect(document.querySelector('.ant-popover')?.textContent).toContain('显示字段');
  });
  it('clears inaccessible selected rows after a successful refresh, but keeps selection on a transient failure', async () => {
    let visible = true, failed = false;
    const port = { key: 'fixture', list: vi.fn(async () => failed ? { success: false, error: '离线' } : { success: true, data: { items: visible ? [contact] : [], total: visible ? 1 : 0 } }), listIds: vi.fn(async () => failed ? { success: false, error: '离线' } : { success: true, data: { ids: visible ? [42] : [] } }), canDelete: () => true } as unknown as ContactDataPort;
    await act(async () => root.render(<QueryClientProvider client={client}><ContactList dataPort={port} renderDetail={() => null} /></QueryClientProvider>)); await act(flush);
    await act(async () => { (host.querySelectorAll('input[type="checkbox"]')[1] as HTMLInputElement).click(); await flush(); });
    expect(host.textContent).toContain('已选择 1 项');
    failed = true;
    await act(async () => { await client.invalidateQueries({ queryKey: ['center-contacts'] }); await flush(); });
    expect(host.textContent).toContain('已选择 1 项');
    failed = false; visible = false;
    await act(async () => { await client.invalidateQueries({ queryKey: ['center-contacts'] }); await flush(); });
    expect(host.textContent).not.toContain('已选择 1 项');
  }, 20000);
  it('refreshes an already open company detail when a remote contact disappears', async () => {
    let visible = true;
    const company = { id: 9, name: 'Fixture company', domain: null };
    const port = { key: 'fixture', list: async () => ({ success: true, data: { items: [{ ...company, contactCount: visible ? 1 : 0 }], total: 1 } }), detail: vi.fn(async () => ({ success: true, data: { company, contacts: visible ? [contact] : [], sentCount: null, repliedCount: null, canEdit: false } })) } as unknown as CompanyDataPort;
    await act(async () => root.render(<QueryClientProvider client={client}><CompanyPage dataPort={port} /></QueryClientProvider>)); await act(flush);
    await act(async () => { (Array.from(host.querySelectorAll('span')).find(node => node.textContent === 'Fixture company')!.parentElement!.parentElement as HTMLElement).click(); await flush(); });
    await act(flush);
    expect(host.textContent).toContain(contact.email);
    visible = false;
    await act(async () => { await client.invalidateQueries({ queryKey: ['center-companies'] }); await flush(); });
    await act(flush);
    expect(host.textContent).not.toContain(contact.email);
  }, 20000);
});
