// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AdminApp } from '../../admin-web/ui';
import { api } from '../../admin-web/api';
import { productPermissionsFor, type ManagedUser } from '../../server/core/admin';

const actor: ManagedUser = { userId: 'actor', email: 'actor@example.invalid', displayName: 'Actor', emailVerified: true, identityAdmin: true, active: true, revision: 1, accessActive: true, crmRoles: ['admin'], ...productPermissionsFor('admin') };
const legacy: ManagedUser = { ...actor, userId: 'target', email: 'target@example.invalid', displayName: 'Target', identityAdmin: false, crmRoles: ['operations', 'sales'], scope: 'shared', capabilities: productPermissionsFor('operations').capabilities };
describe('A2 management single identity renderer', () => {
  let root: Root, host: HTMLDivElement;
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
    vi.spyOn(api, 'me').mockResolvedValue({ identity: actor, csrf: '' });
    vi.spyOn(api, 'users').mockImplementation(async search => ({ items: search === actor.email ? [actor] : [legacy], total: 1 }));
    vi.spyOn(api, 'sessions').mockResolvedValue([]);
    vi.spyOn(api, 'command').mockResolvedValue({});
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
  const flush = () => new Promise(resolve => setTimeout(resolve, 30));
  async function click(label: string) { await act(async () => { Array.from(host.querySelectorAll('button')).find(button => button.textContent?.trim() === label)!.click(); await flush(); }); }
  async function clickDocument(label: string) { await act(async () => { Array.from(document.querySelectorAll('button')).find(button => button.textContent?.trim() === label)!.click(); await flush(); }); }
  function setInput(input: HTMLInputElement, value: string) { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); }
  async function editor() {
    await act(async () => { root.render(<AdminApp initialChallenge={null} />); await flush(); });
    await click('Target');
    await act(async () => { Array.from(host.querySelectorAll('[role="tab"]')).find(tab => tab.textContent === '产品权限')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); });
  }
  it('collapses legacy multiple roles into one label and removes manual capability and scope controls', async () => {
    await editor();
    expect(host.querySelector('input[aria-label="产品身份"]')?.closest('.ant-select')?.classList.contains('ant-select-multiple')).toBe(false);
    expect(host.querySelector('.account-person-meta')?.textContent).toContain('管理员');
    expect(host.querySelector('.account-person-meta')?.textContent).not.toContain('管理员、用户');
    expect(host.textContent).not.toContain('角色模板');
    expect(host.textContent).not.toContain('功能权限');
    expect(host.textContent).not.toContain('数据范围');
    expect(host.querySelector('.ant-checkbox-group')).toBeNull();
    expect(api.command).not.toHaveBeenCalled();
  });
  it('saves a single explicit identity with compatible derived fields', async () => {
    await editor(); await click('保存配置');
    expect(api.command).toHaveBeenCalledWith(expect.objectContaining({ action: 'product.update', userId: 'target', role: 'operations', ...productPermissionsFor('operations') }));
  });
  it('requires the administrator to set an initial password when creating a user', async () => {
    await act(async () => { root.render(<AdminApp initialChallenge={null} />); await flush(); });
    await click('创建用户');
    const dialog = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).find(element => element.textContent?.includes('初始密码'))!;
    const email = Array.from(dialog.querySelectorAll<HTMLInputElement>('input')).find(input => input.type !== 'password' && input.getAttribute('role') !== 'combobox')!;
    const passwords = Array.from(dialog.querySelectorAll<HTMLInputElement>('input[type="password"]'));
    expect(passwords).toHaveLength(2);
    await act(async () => {
      setInput(email, 'operator@example.invalid');
      setInput(passwords[0]!, 'Init123');
      setInput(passwords[1]!, 'Init123');
      await flush();
    });
    await act(async () => { Array.from(dialog.querySelectorAll('button')).find(button => button.textContent?.trim() === '创建用户')!.click(); await flush(); });
    expect(api.command).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.create', email: 'operator@example.invalid' }), 'Init123');
  });
  it('offers password change after login and signs out after it succeeds', async () => {
    vi.spyOn(api, 'password').mockResolvedValue(undefined);
    await act(async () => { root.render(<AdminApp initialChallenge={null} />); await flush(); });
    await click('修改密码');
    const dialog = document.querySelector('[role="dialog"]')!;
    const inputs = Array.from(dialog.querySelectorAll<HTMLInputElement>('input[type="password"]'));
    expect(inputs).toHaveLength(3);
    await act(async () => { setInput(inputs[0]!, 'current1'); setInput(inputs[1]!, 'newpass1'); setInput(inputs[2]!, 'newpass1'); await flush(); });
    await clickDocument('修改密码并重新登录');
    expect(api.password).toHaveBeenCalledWith('current1', 'newpass1');
    expect(host.textContent).toContain('登录管理工作台');
  });
});
