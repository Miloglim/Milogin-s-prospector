import {describe,it,expect,vi} from 'vitest';
import {createLeadService} from '../../server/services/leads';
import type {LeadRepository} from '../../server/core/leads';
import {success} from '../../server/core/crm';
const TOKEN='a'.repeat(43), ID='00000000-0000-0000-0000-000000000001';
function setup(){const followup=vi.fn().mockResolvedValue(success({}));const service=createLeadService({followup} as unknown as LeadRepository,{hash:()=> 'hash'} as never);return {service,followup};}
const request={customerId:ID,expectedVersion:1,idempotencyKey:'test',note:'Synthetic phone contact'};
describe('customer followup service boundaries',()=>{
 it('forwards reached-only list queries and rejects invalid or pool filters',async()=>{
  const list=vi.fn().mockResolvedValue(success({items:[],total:0}));
  const service=createLeadService({list} as unknown as LeadRepository,{hash:()=> 'hash'} as never);
  const query={view:'personal' as const,search:'',limit:25,offset:0,followupOnly:true};
  expect((await service.list(TOKEN,query)).ok).toBe(true);expect(list).toHaveBeenCalledWith('hash',query);
  expect(await service.list(TOKEN,{...query,followupOnly:'true' as unknown as boolean})).toMatchObject({error:{code:'INVALID_INPUT'}});
  expect(await service.list(TOKEN,{...query,view:'pool'})).toMatchObject({error:{code:'INVALID_INPUT'}});
 });
 it('allows a valid opportunity association without inferring customer stage',async()=>{const {service,followup}=setup();const linked={...request,opportunityId:ID};expect((await service.followup(TOKEN,linked)).ok).toBe(true);expect(followup).toHaveBeenCalledWith('hash',linked);expect(await service.followup(TOKEN,{...request,opportunityId:'bad'})).toMatchObject({error:{code:'INVALID_INPUT'}});});
 it('accepts company-level contact, cold stage and all explicit fields without normalizing idempotency input',async()=>{const {service,followup}=setup();const input={...request,method:'phone',stage:'cold',occurredAt:'2020-01-02T12:30:00+08:00',contactId:1,contactStatus:'replied'};expect((await service.followup(TOKEN,input)).ok).toBe(true);expect(followup).toHaveBeenCalledWith('hash',input);expect((await service.followup(TOKEN,{...request,method:'visit'})).ok).toBe(true);expect((await service.followup(TOKEN,request)).ok).toBe(true);});
 it.each([{contactStatus:'contacted'},{method:'note',contactId:1,contactStatus:'replied'},{contactId:0},{contactId:1.5},{contactStatus:'sent',contactId:1},{method:'legacy'},{stage:'2'},{unexpected:true}])('rejects invalid/contact-result payload %j',async extra=>{const {service,followup}=setup();expect(await service.followup(TOKEN,{...request,...extra})).toMatchObject({error:{code:'INVALID_INPUT'}});expect(followup).not.toHaveBeenCalled();});
 it.each(['2026-01-02','2026-01-02T00:00:00','2026-02-30T00:00:00Z','2026-01-02T25:00:00Z','2026-01-02T00:00:00+24:00','not a date',new Date(Date.now()+120000).toISOString()])('rejects invalid or future occurrence %s',async occurredAt=>{const {service,followup}=setup();expect(await service.followup(TOKEN,{...request,occurredAt})).toMatchObject({error:{code:'INVALID_INPUT'}});expect(followup).not.toHaveBeenCalled();});
 it('accepts timezone ISO and validates sessions',async()=>{const {service,followup}=setup();expect((await service.followup(TOKEN,{...request,occurredAt:new Date().toISOString()})).ok).toBe(true);expect(await service.followup('bad',request)).toMatchObject({error:{code:'UNAUTHORIZED'}});expect(followup).toHaveBeenCalledTimes(1);});
});
