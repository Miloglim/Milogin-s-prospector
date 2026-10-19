import { afterEach, describe, expect, it, vi } from 'vitest';
import { setAgentContactPort, mutateAgentContact, type AgentContactPort } from '../../src/main/services/agent-contact.service';
import { pickTarget, pickByEmail, resolveContacts, execSearchContacts, execRecordFollowup, execUpdateContact, execDeleteContacts, execImportContacts } from '../../src/main/services/agent/toolkit/contacts';
import { execGenerateDraft, execSendQueueAdd, execCampaignCreate, execRemindersDue } from '../../src/main/services/agent/toolkit/send';
import type { CenterContact, CenterContactDetail } from '../../src/shared/online-crm';
import type { ToolCtx } from '../../src/main/services/agent/types';

const spies = vi.hoisted(() => ({ db: vi.fn(() => { throw Error('Legacy DB must not be read'); }), audit: vi.fn() }));
vi.mock('../../src/main/db', () => ({ getDb: spies.db, getRawDb: spies.db, saveDatabase: spies.db }));
vi.mock('../../src/main/services/agent/toolkit/common', async importOriginal => ({ ...await importOriginal<typeof import('../../src/main/services/agent/toolkit/common')>(), gate: () => null, audit: spies.audit }));
const customerId = '12345678-1234-1234-1234-123456789abc';
const row: CenterContact = { contactId:701,customerId,customerVersion:2,contactVersion:4,companyId:8,companyName:'Acme Logistics',email:'ana@acme.test',firstName:'Ana',lastName:'Silva',title:null,phone:null,linkedinUrl:null,country:'Brazil',clientType:'agent',language:'PT',stage:'cold',status:'',tags:['priority'],extra:{preferences:['Santos'],provenance:'keep'},touchStatus:'uncontacted',assignee:'',source:'manual',sourceDetail:null,createdAt:'2026-10-15T00:00:00Z',updatedAt:'2026-10-15T00:00:00Z',ownerUserId:null,ownerName:null,origin:'personal',state:'owned',assignmentStatus:null,relationshipStage:'cold',lastFollowupAt:null,lastFollowupNote:null,canEdit:true,canFollowup:true,canAssign:false };
function fixture() {
 let active = true;
 const detail: CenterContactDetail = { contact: { ...row, contactVersion:5 }, activities:[], company:{companyId:8,name:'Acme Logistics',domain:null,backcheckData:null},canEdit:true,canFollowup:true,canAssign:false,mailAvailable:true,mailEvents:[],mailEventLimit:50 };
 const port: AgentContactPort = { snapshot:vi.fn(() => ({ok:true,data:{scope:'account-A',active:()=>active,contacts:[row]}})), update:vi.fn(async()=>({ok:true,data:detail})), followup:vi.fn(async()=>({ok:true,data:detail})), createKey:vi.fn(()=>crypto.randomUUID()), now:()=>Date.now(), report:vi.fn() };
 setAgentContactPort(port);
 const ctx: ToolCtx = {conversationId:crypto.randomUUID(),push:vi.fn(),counts:new Map(),failures:new Map()};
 return {port,ctx,detail,changeAccount:()=>{active=false;}};
}
afterEach(()=>{setAgentContactPort(null);vi.clearAllMocks();});

describe('Agent center contact execution boundaries',()=>{
 it('checks exact shared fields before writing and exposes grants to AI',async()=>{
  const {port,ctx}=fixture();
  const permissions={editableFields:['phone'],canFollowup:false,canChangeStage:false,canSendMail:true,canShare:false};
  vi.mocked(port.snapshot).mockReturnValue({ok:true,data:{scope:'account-A',active:()=>true,contacts:[{...row,isShared:true,permissions}]}});
  expect(JSON.parse(await execSearchContacts(ctx,{query:'Ana'}))).toMatchObject({results:[{permissions,isShared:true}]});
  expect(await mutateAgentContact(port,ctx.conversationId,'update',{contactId:701,title:'Denied'})).toMatchObject({ok:false,error:{code:'FORBIDDEN'}});
  expect(port.update).not.toHaveBeenCalled();
  expect((await mutateAgentContact(port,ctx.conversationId,'update',{contactId:701,phone:'123'})).ok).toBe(true);
  expect(port.update).toHaveBeenCalledWith(expect.objectContaining({fields:{phone:'123'}}));
 });
 it('routes import and reminders to the center without legacy SQLite access',async()=>{
  const {port,ctx}=fixture();
  port.importRows=vi.fn(async()=>({ok:true,data:{batchId:'batch',version:1,rows:[{rowId:'r',index:0,status:'created',customerId}]}}));
  port.tasks=vi.fn(async()=>({ok:true,data:{items:[],total:0}}));
  expect(JSON.parse(await execImportContacts(ctx,{contacts:[{email:'test@example.test',company:'Test Co'}]}))).toMatchObject({ok:true,imported:1,batchId:'batch'});
  expect(JSON.parse(await execRemindersDue(ctx,{}))).toMatchObject({ok:true,source:'center_tasks',dueCount:0,partial:false});
  expect(port.importRows).toHaveBeenCalledTimes(1);
  expect(port.tasks).toHaveBeenCalledTimes(1);
  expect(spies.db).not.toHaveBeenCalled();
 });
 it('uses authorized center data and never creates legacy send actions',async()=>{
  const {ctx}=fixture();
  const output=JSON.parse(await execSearchContacts(ctx,{query:'Ana Acme'}));
  expect(output).toMatchObject({ok:true,total:1,results:[{id:701,customerId,tags:['priority'],touchStatus:'uncontacted',relationshipStage:'cold'}]});
  expect(output.actions).toBeUndefined();
  expect(spies.db).not.toHaveBeenCalled();
 });
 it('reports sync failure as failure, bypassing legacy search cache',async()=>{
  const {port,ctx}=fixture();
  expect(JSON.parse(await execSearchContacts(ctx,{query:'Ana'})).ok).toBe(true);
  vi.mocked(port.snapshot).mockReturnValue({ok:false,error:{code:'UNAVAILABLE',message:'syncing'}});
  expect(JSON.parse(await execSearchContacts(ctx,{query:'Ana'}))).toMatchObject({ok:false,error:{code:'UNAVAILABLE'}});
  expect(spies.db).not.toHaveBeenCalled();
 });
 it('prevents legacy callers and unsupported tools from treating a center id as SQLite',async()=>{
  const {ctx}=fixture();
  expect(resolveContacts('Ana')).toEqual([]);
  expect(pickTarget({contactId:701})).toMatchObject({ok:false});
  expect(pickByEmail('ana@acme.test')).toBeNull();
  const outputs=await Promise.all([
   execDeleteContacts(ctx,{contactIds:[701]}), execImportContacts(ctx,{contacts:[{email:'a@b.test'}]}),
   execRemindersDue(ctx,{}),
  ]);
  outputs.forEach(output=>expect(JSON.parse(output)).toMatchObject({ok:false,error:{code:'UNAVAILABLE'}}));
  expect(spies.db).not.toHaveBeenCalled();
 });
 it('does not guess industry from arbitrary extra fields',async()=>{
  const {ctx}=fixture();
  expect(JSON.parse(await execSearchContacts(ctx,{industry:'furniture'}))).toMatchObject({ok:false,error:{code:'UNAVAILABLE'}});
 });
 it('rejects a missing explicit id instead of falling back to a matching name',async()=>{
  const {port,ctx}=fixture();
  expect(JSON.parse(await execRecordFollowup(ctx,{contactId:999,contact:'Ana',note:'note'}))).toMatchObject({ok:false,error:{code:'NOT_FOUND'}});
  expect(port.followup).not.toHaveBeenCalled();
  expect(spies.db).not.toHaveBeenCalled();
 });
 it('rejects ambiguous emails and read-only contacts',async()=>{
  const {port,ctx}=fixture();
  vi.mocked(port.snapshot).mockReturnValue({ok:true,data:{scope:'account-A',active:()=>true,contacts:[row,{...row,contactId:702}]}});
  expect(await mutateAgentContact(port,ctx.conversationId,'followup',{contact:'ana@acme.test',note:'test'})).toMatchObject({ok:false,error:{code:'CONFLICT'}});
  vi.mocked(port.snapshot).mockReturnValue({ok:true,data:{scope:'account-A',active:()=>true,contacts:[{...row,canFollowup:false}]}});
  expect(await mutateAgentContact(port,ctx.conversationId,'followup',{contactId:701,note:'test'})).toMatchObject({ok:false,error:{code:'FORBIDDEN'}});
  expect(port.followup).not.toHaveBeenCalled();
 });
 it('writes notes as notes without manufacturing touch or relationship changes',async()=>{
  const {port,ctx}=fixture();
  expect(JSON.parse(await execRecordFollowup(ctx,{contactId:701,note:'Called at noon'})).ok).toBe(true);
  expect(port.followup).toHaveBeenCalledWith(expect.objectContaining({contactId:701,customerId,expectedVersion:4,note:'Called at noon',method:'note'}));
  const input=vi.mocked(port.followup).mock.calls[0]![0];
  expect(input.contactStatus).toBeUndefined();expect(input.stage).toBeUndefined();
 });
 it('sends only a bounded preferences patch and real tags',async()=>{
  const {port,ctx}=fixture();
  expect(JSON.parse(await execUpdateContact(ctx,{contactId:701,preference:'Manzanillo',tags:'priority,priority,重点'})).ok).toBe(true);
  expect(port.update).toHaveBeenCalledWith(expect.objectContaining({fields:{preferences:['Santos','Manzanillo'],tags:['priority','重点']}}));
  expect(vi.mocked(port.update).mock.calls[0]![0].fields).not.toHaveProperty('extra');
 });
 it('retries lost receipts using the exact original key, version and fields',async()=>{
  const {port,ctx}=fixture();
  vi.mocked(port.followup).mockRejectedValueOnce(Error('response lost'));
  const args={contactId:701,note:'test'};
  expect(await mutateAgentContact(port,ctx.conversationId,'followup',args)).toMatchObject({ok:false,error:{code:'UNAVAILABLE'}});
  vi.mocked(port.snapshot).mockReturnValue({ok:true,data:{scope:'account-A',active:()=>true,contacts:[{...row,contactVersion:5}]}});
  expect(await mutateAgentContact(port,ctx.conversationId,'followup',args)).toMatchObject({ok:true});
  expect(vi.mocked(port.followup).mock.calls[0]![0]).toEqual(vi.mocked(port.followup).mock.calls[1]![0]);
  await mutateAgentContact(port,ctx.conversationId,'followup',args);
  expect(port.followup).toHaveBeenCalledTimes(2);
 });
 it('coalesces concurrent duplicate writes',async()=>{
  const {port,ctx}=fixture();
  await Promise.all(Array.from({length:4},()=>mutateAgentContact(port,ctx.conversationId,'update',{contactId:701,title:'Director'})));
  expect(port.update).toHaveBeenCalledTimes(1);
 });
 it('rejects delayed receipts after account switch without cross-account audit',async()=>{
  const {port,ctx,detail,changeAccount}=fixture();
  vi.mocked(port.followup).mockImplementation(async()=>{changeAccount();return {ok:true,data:detail};});
  expect(JSON.parse(await execRecordFollowup(ctx,{contactId:701,note:'test'}))).toMatchObject({ok:false,error:{code:'UNAUTHORIZED'}});
  expect(spies.audit).not.toHaveBeenCalled();
 });
 it('does not reuse a successful receipt for another account scope',async()=>{
  const {port,ctx}=fixture();const args={contactId:701,title:'Director'};
  await mutateAgentContact(port,ctx.conversationId,'update',args);
  vi.mocked(port.snapshot).mockReturnValue({ok:true,data:{scope:'account-B',active:()=>true,contacts:[row]}});
  await mutateAgentContact(port,ctx.conversationId,'update',args);
  expect(port.update).toHaveBeenCalledTimes(2);
  expect(vi.mocked(port.update).mock.calls[0]![0].idempotencyKey).not.toBe(vi.mocked(port.update).mock.calls[1]![0].idempotencyKey);
 });
 it('does not return cached success after contact access is removed',async()=>{
  const {port,ctx}=fixture();const args={contactId:701,title:'Director'};
  await mutateAgentContact(port,ctx.conversationId,'update',args);
  vi.mocked(port.snapshot).mockReturnValue({ok:true,data:{scope:'account-A',active:()=>true,contacts:[]}});
  expect(await mutateAgentContact(port,ctx.conversationId,'update',args)).toMatchObject({ok:false,error:{code:'FORBIDDEN'}});
  expect(port.update).toHaveBeenCalledTimes(1);
 });
 it('rejects a receipt for the wrong contact',async()=>{
  const {port,ctx,detail}=fixture();
  vi.mocked(port.update).mockResolvedValue({ok:true,data:{...detail,contact:{...detail.contact,contactId:702}}});
  expect(await mutateAgentContact(port,ctx.conversationId,'update',{contactId:701,title:'Director'})).toMatchObject({ok:false,error:{code:'DATABASE_ERROR'}});
 });

});
