// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {LegacyCustomersPage} from '../../src/renderer/pages/customers/LegacyCustomersPage';
vi.mock('../../src/renderer/IdentityContext',()=>({useIdentity:()=>({identity:{userId:'fixture',crmRoles:['sales'],crmCapabilities:[]},baseUrl:'http://fixture.invalid',status:'authenticated'})}));
vi.mock('../../src/renderer/pages/contacts/ContactList',()=>({ContactList:()=> <div>Original contact table</div>}));
vi.mock('../../src/renderer/pages/customers/CenterContactViews',()=>({CenterContactViews:()=>null}));
vi.mock('../../src/renderer/pages/customers/CenterContactDetail',()=>({CenterContactDetail:()=>null}));
vi.mock('../../src/renderer/pages/customers/ContactAssignments',()=>({ContactAssignments:()=>null,AssignmentModal:()=>null}));
vi.mock('../../src/renderer/pages/customers/centerContactPort',()=>({createCenterContactPort:()=>({records:new Map()}),createCenterImportPort:()=>({}),centerInvoke:vi.fn()}));
describe('original customer route',()=>{
 let host:HTMLDivElement,root:Root,client:QueryClient,invoke:ReturnType<typeof vi.fn>;
 const flush=()=>new Promise(resolve=>setTimeout(resolve,40));
 beforeEach(()=>{
  (globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
  window.location.hash='#/customers';
  Object.defineProperty(window,'matchMedia',{configurable:true,value:()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}})});
 invoke=vi.fn(async()=>({ok:true,data:{connection:'online',syncing:false,pending:0,failed:0,conflicts:0,issues:[]}}));
  Object.defineProperty(window,'api',{configurable:true,value:{invoke}});
  client=new QueryClient({defaultOptions:{queries:{retry:false}}});host=document.createElement('div');document.body.append(host);root=createRoot(host);
 });
 afterEach(async()=>{await act(async()=>root.unmount());client.clear();host.remove();});
 it('keeps customer navigation free of manual sync controls',async()=>{
  const invalidate=vi.spyOn(client,'invalidateQueries');
  await act(async()=>root.render(<QueryClientProvider client={client}><LegacyCustomersPage/></QueryClientProvider>));await act(flush);
  expect(host.textContent).toContain('跟进看板');
  expect(host.textContent).toContain('联系人');
  expect(host.textContent).toContain('分配线索');
  expect(host.textContent).toContain('公司');
  expect(host.querySelector('.crm-sync-bar')).toBeNull();
  const header=host.firstElementChild!.firstElementChild!;
  expect(header.querySelector('.ant-segmented')).not.toBeNull();
  expect(Array.from(header.querySelectorAll('button')).some(x=>x.textContent?.replace(/\s/g,'').includes('同步'))).toBe(false);
  expect(document.body.textContent).not.toContain('客户同步');
  expect(document.body.textContent).not.toContain('立即同步');
  expect(invalidate).not.toHaveBeenCalled();
 });
});
