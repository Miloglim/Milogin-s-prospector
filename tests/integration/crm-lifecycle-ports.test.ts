import { describe,it,expect,vi } from 'vitest';
import {createCenterContactPort} from '../../src/renderer/pages/customers/centerContactPort';
import {createCenterCompanyPort} from '../../src/renderer/pages/customers/centerCompanyPort';
import {ONLINE_CHANNELS,type CenterContact} from '../../src/shared/online-crm';
const row={contactId:42,customerId:'12345678-1234-1234-1234-123456789abc',customerVersion:3,contactVersion:7,canDelete:true,tags:[],email:'test@example.invalid'} as unknown as CenterContact;
describe('original CRM lifecycle adapters',()=>{
 it('keeps the same delete command after an unknown result and never calls legacy IDs',async()=>{
  let attempts=0;const calls:unknown[]=[];
  const invoke=vi.fn(async(channel,input)=>{if(channel===ONLINE_CHANNELS.CONTACT_LIST)return {ok:true,data:{items:[row],total:1}};calls.push(input);return ++attempts===1?{ok:false,error:{code:'UNAVAILABLE',message:'unknown'}}:{ok:true,data:{deleted:[{contactId:42,customerId:row.customerId,contactVersion:8}]}};});
  const port=createCenterContactPort({key:'k',invoke:invoke as never});await port.list();expect(await port.delete(42)).toMatchObject({success:false});expect(await port.delete(42)).toMatchObject({success:true});expect(calls[0]).toEqual(calls[1]);expect(calls[0]).toMatchObject({contacts:[{contactId:42,customerId:row.customerId,expectedVersion:7}]});expect(port.records.has(42)).toBe(false);expect(invoke.mock.calls.some(([channel])=>channel.startsWith('contacts:'))).toBe(false);
 });
 it('rejects mixed protected batches and stale-account operations before IPC',async()=>{
  let active=true;const invoke=vi.fn(async()=>({ok:true,data:{items:[row,{...row,contactId:43,canDelete:false}],total:2}}));const port=createCenterContactPort({key:'k',invoke:invoke as never,isCurrent:()=>active});await port.list();expect(await port.deleteBatch!([42,43])).toMatchObject({success:false});active=false;expect(await port.delete(42)).toMatchObject({success:false});expect(invoke).toHaveBeenCalledTimes(1);
 });
 it('creates empty company via a dedicated contract, preserves errors and blocks offline writes',async()=>{
  const invoke=vi.fn(async()=>({ok:false,error:{code:'UNAVAILABLE',message:'unknown'}}));const contacts=createCenterContactPort({key:'k',invoke:invoke as never});const port=createCenterCompanyPort(contacts,false,invoke as never);
  const input={name:'Empty',domain:'example.invalid'};expect(await port.update!(input)).toMatchObject({success:false,error:'unknown'});await port.update!(input);expect(invoke.mock.calls[0]).toEqual(invoke.mock.calls[1]);expect(invoke.mock.calls[0]?.[0]).toBe(ONLINE_CHANNELS.COMPANY_CREATE);
  const offline=createCenterCompanyPort(contacts,true,invoke as never);expect(offline.canCreate).toBe(false);await offline.update!(input);await offline.delete!(1);expect(invoke).toHaveBeenCalledTimes(2);
 });
 it('deletes only loaded empty companies with their separate opaque company revision',async()=>{
  const company={companyId:9,name:'Empty',domain:null,revision:'2026-10-16 00:00:00.123456+00',canDelete:true,createdAt:'2026-10-16',updatedAt:'2026-10-16',contactCount:0};
  const invoke=vi.fn(async(channel)=>channel===ONLINE_CHANNELS.COMPANY_DETAIL?{ok:true,data:{company,contacts:[]}}:{ok:true,data:{companyId:9}});const contacts=createCenterContactPort({key:'k',invoke:invoke as never});const port=createCenterCompanyPort(contacts,false,invoke as never);
  expect(await port.delete!(9)).toMatchObject({success:false});await port.detail(9);expect(await port.delete!(9)).toMatchObject({success:true});expect(invoke).toHaveBeenLastCalledWith(ONLINE_CHANNELS.COMPANY_DELETE,expect.objectContaining({companyId:9,expectedRevision:company.revision}));
 });
});
