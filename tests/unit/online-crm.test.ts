import {describe,it,expect,vi} from 'vitest';
import {randomBytes} from 'node:crypto';
vi.mock('electron',()=>({dialog:{showOpenDialog:vi.fn()}}));
vi.mock('../../src/main/logger',()=>({Log:{error:vi.fn()}}));
import {OnlineCrmAdapter,loopbackCenter} from '../../src/main/adapters/online-crm.adapter';
import {createOnlineCrmService} from '../../src/main/services/online-crm.service';
import {success} from '../../server/core/crm';
const identity={userId:'synthetic-user',displayName:'Synthetic',email:'synthetic@example.invalid',emailVerified:true,identityAdmin:false,crmRoles:['sales']};
const json=(data:unknown)=>new Response(JSON.stringify(success(data)));
describe('desktop center isolation',()=>{
  it('a stale first login identity failure cannot clear the newer session bearer',async()=>{
    const firstToken=randomBytes(32).toString('base64url');const secondToken=randomBytes(32).toString('base64url');let finish:((value:Response)=>void)|undefined;let started:()=>void=()=>{};
    const firstMe=new Promise<void>(resolve=>{started=resolve;});let loginCount=0;
    const fetcher=vi.fn(async(url:string,init:RequestInit)=>{if(url.endsWith('/login'))return json({token:++loginCount===1?firstToken:secondToken,identity});if(url.endsWith('/me')&&(init.headers as Record<string,string>).Authorization===`Bearer ${firstToken}`){started();return await new Promise<Response>(resolve=>{finish=resolve;});}return json(identity);});
    const adapter=new OnlineCrmAdapter(fetcher as unknown as typeof fetch);const input={baseUrl:'http://127.0.0.1:55844',email:identity.email,password:randomBytes(24).toString('base64url')};
    const old=adapter.login(input);await firstMe;expect((await adapter.login(input)).ok).toBe(true);finish!(json(identity));expect((await old).ok).toBe(false);
    expect((await adapter.request('GET','/api/crm/bootstrap')).ok).toBe(true);
    expect((fetcher.mock.calls.at(-1)![1].headers as Record<string,string>).Authorization).toBe(`Bearer ${secondToken}`);
  });
  it('allows only explicit loopback origin and rejects URL credentials and redirects targets',()=>{
    expect(loopbackCenter('http://127.0.0.1:55844')).toBe('http://127.0.0.1:55844');
    for(const url of ['https://127.0.0.1','http://localhost:55844','http://example.invalid','http://user@127.0.0.1','http://127.0.0.1/api'])expect(loopbackCenter(url)).toBeNull();
  });
  it('keeps bearer out of renderer login result and invalidates in-flight old identity reads',async()=>{
    const token=randomBytes(32).toString('base64url');let finish:((value:Response)=>void)|undefined;
    const calls:RequestInit[]=[];
    const fetcher=vi.fn(async(url:string,init:RequestInit)=>{calls.push(init);if(url.endsWith('/login'))return json({token,identity});if(url.endsWith('/me'))return json(identity);if(url.endsWith('/logout'))return json(undefined);return await new Promise<Response>(resolve=>{finish=resolve;});});
    const adapter=new OnlineCrmAdapter(fetcher as unknown as typeof fetch);
    const logged=await adapter.login({baseUrl:'http://127.0.0.1:55844',email:identity.email,password:randomBytes(24).toString('base64url')});
    expect(logged).toEqual(success(identity));expect(JSON.stringify(logged)).not.toContain(token);
    const read=adapter.request('GET','/api/crm/leads');await adapter.logout();finish!(json({private:'old-owner'}));
    expect((await read).ok).toBe(false);expect((await adapter.request('GET','/api/crm/leads')).ok).toBe(false);
    expect(calls.every(call=>call.redirect==='error')).toBe(true);
  });
  it('maps exact center commands without accessing local CRM',async()=>{
    const request=vi.fn(async()=>success({}));const service=createOnlineCrmService({request,login:vi.fn(),logout:vi.fn(),preview:vi.fn(),feed:vi.fn()});
    const command={customerId:'specific-customer',expectedVersion:3,idempotencyKey:'fixed-key'};
    await service.detail('exact-object');expect(request).toHaveBeenCalledWith('GET','/api/crm/leads/exact-object');
    const customer={companyName:'Synthetic customer',source:'manual',sourceDetail:'',contacts:[{email:'synthetic@example.invalid'}],idempotencyKey:'create-key'};
    await service.createCustomer(customer);expect(request).toHaveBeenCalledWith('POST','/api/crm/leads',customer);
    const update={...command,companyName:customer.companyName,contacts:customer.contacts};
    await service.updateCustomer(update);expect(request).toHaveBeenCalledWith('POST','/api/crm/leads/specific-customer/update',update);
    expect(service).not.toHaveProperty('assign');expect(service).not.toHaveProperty('claim');
    await service.members({search:'name & team',limit:25,offset:25});expect(request).toHaveBeenCalledWith('GET','/api/crm/members?search=name%20%26%20team&limit=25&offset=25');
    await service.list({view:'operations',search:'name & team',limit:25,offset:25,assignment:'unassigned',stage:'cold'});
    expect(request).toHaveBeenCalledWith('GET','/api/crm/leads?view=operations&search=name%20%26%20team&limit=25&offset=25&assignment=unassigned&stage=cold');
    await service.list({view:'personal',search:'',limit:25,offset:0});
    expect(request).toHaveBeenCalledWith('GET','/api/crm/leads?view=personal&search=&limit=25&offset=0');
    const workbook={source:'worksheet',sourceDetail:'',kind:'operations' as const,idempotencyKey:'workbook-key',rows:[{entity:'customer' as const,sourceRef:'row-1',companyName:'Without contacts',sheetName:'Customers',rowNumber:2,rawRow:{}}]};
    await service.importWorkbook(workbook);expect(request).toHaveBeenCalledWith('POST','/api/crm/workbook-imports',workbook);
    expect((await service.workbookPreview()).ok).toBe(false);
  });
  it('replays durable notifications on reset and ignores a late pre-reset cursor',async()=>{
    const token=randomBytes(32).toString('base64url');let finish:((value:Response)=>void)|undefined;let pending=false;
    const feedPaths:string[]=[];
    const fetcher=vi.fn(async(url:string)=>{if(url.endsWith('/login'))return json({token,identity});if(url.endsWith('/me'))return json(identity);feedPaths.push(url);if(pending)return new Promise<Response>(resolve=>{finish=resolve;});return json({items:[],nextCursor:'8',hasMore:false});});
    const adapter=new OnlineCrmAdapter(fetcher as unknown as typeof fetch);
    await adapter.login({baseUrl:'http://127.0.0.1:55844',email:identity.email,password:randomBytes(24).toString('base64url')});
    expect((await adapter.feed()).ok).toBe(true);pending=true;const late=adapter.feed();pending=false;
    expect((await adapter.feed({reset:true})).ok).toBe(true);expect(feedPaths.at(-1)).toContain('after=0&');
    finish!(json({items:[],nextCursor:'99',hasMore:false}));expect((await late).ok).toBe(false);
    await adapter.feed();expect(feedPaths.at(-1)).toContain('after=8&');
    expect((await adapter.feed({reset:'invalid'} as never)).ok).toBe(false);
  });
});
