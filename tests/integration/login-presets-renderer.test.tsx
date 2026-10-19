// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
const fireEvent={click:(node:Element)=>node.dispatchEvent(new MouseEvent('click',{bubbles:true})),submit:(node:Element)=>node.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))};
import {ProductLogin} from '../../src/renderer/components/ProductLogin';
const fixture=vi.hoisted(()=>({session:{} as any}));
vi.mock('../../src/renderer/IdentityContext',()=>({useIdentity:()=>fixture.session}));
vi.mock('../../src/renderer/components/layout/AppLayout',()=>({TitleBar:()=>null}));
vi.mock('../../src/renderer/components/DiamondLogo',()=>({DiamondLogo:()=>null}));
describe('QQ-style login presets without exposing secrets',()=>{
 let root:Root,host:HTMLDivElement;
 const a={accountId:'a',baseUrl:'http://127.0.0.1:55844',email:'a@example.invalid',remembered:true,autoLogin:false,lastUsedAt:2};
 const b={...a,accountId:'b',email:'b@example.invalid',remembered:false,lastUsedAt:1};
 beforeEach(()=>{(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;host=document.createElement('div');document.body.append(host);root=createRoot(host);fixture.session={identity:null,busy:false,error:'',baseUrl:a.baseUrl,remembered:false,accounts:[a,b],selectedAccountId:'a',login:vi.fn(),loginAccount:vi.fn(),removeAccount:vi.fn(async()=>true),register:vi.fn(),logout:vi.fn()};});
 afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
 const mount=()=>act(async()=>root.render(<ProductLogin/>));
 it('prefills a saved account and uses main-owned credentials only after explicit login',async()=>{
  await mount();expect((host.querySelector('#email') as HTMLInputElement).value).toBe(a.email);expect((host.querySelector('[name=autoLogin]') as HTMLInputElement).checked).toBe(false);
  expect((host.querySelector('#password') as HTMLInputElement).value).toBe('');expect(fixture.session.loginAccount).not.toHaveBeenCalled();
  await act(async()=>fireEvent.submit(host.querySelector('form')!));expect(fixture.session.loginAccount).toHaveBeenCalledWith({accountId:'a',autoLogin:false});expect(fixture.session.login).not.toHaveBeenCalled();
 });
 it('switches to a preset without credentials and requires a typed password',async()=>{
  await mount();await act(async()=>fireEvent.click(host.querySelector('[aria-label="选择账号"]')!));await act(async()=>fireEvent.click(host.querySelector('[data-account-id="b"]')!));
  expect((host.querySelector('#email') as HTMLInputElement).value).toBe(b.email);expect((host.querySelector('#password') as HTMLInputElement).required).toBe(true);expect((host.querySelector('[name=remember]') as HTMLInputElement).checked).toBe(false);
 });
 it('automatic login implies remembering; disabling remember disables automatic login',async()=>{
  await mount();await act(async()=>fireEvent.click(host.querySelector('[name=autoLogin]')!));expect((host.querySelector('[name=remember]') as HTMLInputElement).checked).toBe(true);
  await act(async()=>fireEvent.click(host.querySelector('[name=remember]')!));expect((host.querySelector('[name=autoLogin]') as HTMLInputElement).checked).toBe(false);expect((host.querySelector('#password') as HTMLInputElement).required).toBe(true);
 });
 it('removing one preset forwards its ID and does not attempt a login',async()=>{
  await mount();await act(async()=>fireEvent.click(host.querySelector('[aria-label="选择账号"]')!));await act(async()=>fireEvent.click(host.querySelector('[aria-label="移除 b@example.invalid"]')!));
  expect(fixture.session.removeAccount).toHaveBeenCalledWith('b');expect(fixture.session.loginAccount).not.toHaveBeenCalled();
 });
});
