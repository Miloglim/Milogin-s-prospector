// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {CenterContactDetail} from '../../src/renderer/pages/customers/CenterContactDetail';
import {ONLINE_CHANNELS} from '../../src/shared/online-crm';
vi.mock('../../src/renderer/IdentityContext',()=>({useIdentity:()=>({identity:{userId:'fixture-user'},baseUrl:'http://fixture.invalid',status:'authenticated'})}));
vi.mock('../../src/renderer/components/ContactDetail',async importOriginal=>({...await importOriginal<typeof import('../../src/renderer/components/ContactDetail')>(),ContactDetailLayout:({children}:{children:React.ReactNode})=><div>{children}</div>,InfoTab:()=>null}));
vi.mock('../../src/renderer/components/CompanyBackcheck',()=>({CompanyBackcheck:({run,centerCompany}:{run?:()=>Promise<unknown>;centerCompany:{backcheckData:string|null}})=><div><button disabled={!run} onClick={()=>void run?.()}>生成背调</button><span>{centerCompany.backcheckData}</span></div>}));
const reference={contactId:42,customerId:'customer-42'};
const report={summary:'Generated fixture report',importActivity:'fixture',categories:[],logisticsFit:'fixture',rating:3,risk:[],sources:[]};
function fixture(write=false){return {contact:{...reference,contactVersion:7,companyId:9,email:'fixture@example.invalid',firstName:'Fixture',tags:[],extra:{},touchStatus:'uncontacted',status:''},company:{companyId:9,name:'Fixture',canEdit:write,revision:'2026-10-16T00:00:00Z',backcheckData:null},permissions:{editableFields:[],canFollowup:false,canChangeStage:false,canSendMail:true,canShare:false},activities:[],canEdit:false,canFollowup:false,mailAvailable:true};}
describe('read-only company backcheck from contact detail',()=>{
 let root:Root,host:HTMLDivElement,client:QueryClient,invoke:ReturnType<typeof vi.fn>,write:boolean;
 const flush=()=>new Promise(resolve=>setTimeout(resolve,40));
 beforeEach(()=>{write=false;(globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;Object.defineProperty(window,'matchMedia',{configurable:true,value:()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}})});invoke=vi.fn(async(channel:string)=>channel==='ai:backcheck'?{success:true,data:{report}}:{ok:true,data:fixture(write)});Object.defineProperty(window,'api',{configurable:true,value:{invoke}});client=new QueryClient({defaultOptions:{queries:{retry:false}}});host=document.createElement('div');document.body.append(host);root=createRoot(host);});
 afterEach(async()=>{await act(async()=>root.unmount());client.clear();host.remove();});
 async function render(ref=reference){await act(async()=>root.render(<QueryClientProvider client={client}><CenterContactDetail reference={ref} onClose={()=>{}}/></QueryClientProvider>));await act(flush);}
 async function openAndRun(){await render();await act(async()=>{(Array.from(host.querySelectorAll('[role="tab"]')).find(x=>x.textContent==='公司背调') as HTMLElement).click();await flush();});const button=Array.from(host.querySelectorAll('button')).find(x=>x.textContent==='生成背调')!;expect(button.disabled).toBe(false);await act(async()=>{button.click();await flush();});}
 it('allows assigned or shared users to generate a transient report without changing company master data',async()=>{await openAndRun();expect(invoke).toHaveBeenCalledWith('ai:backcheck',expect.objectContaining({centerReference:reference}));expect(invoke.mock.calls.some(([channel])=>channel===ONLINE_CHANNELS.COMPANY_UPDATE)).toBe(false);expect(host.textContent).toContain(report.summary);await render({contactId:43,customerId:'customer-43'});expect(host.textContent).not.toContain(report.summary);});
 it('discards a late report when the contact changes during generation',async()=>{let finish!:(value:unknown)=>void;const normal=invoke.getMockImplementation()!;invoke.mockImplementation(async(channel:string)=>channel==='ai:backcheck'?new Promise(resolve=>{finish=resolve;}):normal(channel));await openAndRun();await render({contactId:43,customerId:'customer-43'});await act(async()=>{finish({success:true,data:{report}});await flush();});expect(host.textContent).not.toContain(report.summary);expect(invoke.mock.calls.some(([channel])=>channel===ONLINE_CHANNELS.COMPANY_UPDATE)).toBe(false);});
 it('keeps the authorized company master write path',async()=>{write=true;await openAndRun();expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.COMPANY_UPDATE,expect.objectContaining({...reference,expectedRevision:'2026-10-16T00:00:00Z',fields:{backcheckData:report}}));});
});
