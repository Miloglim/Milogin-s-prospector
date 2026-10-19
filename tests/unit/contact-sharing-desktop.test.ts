import { describe, expect, it, vi } from 'vitest';
import { createOnlineCrmService } from '../../src/main/services/online-crm.service';
import { success } from '../../server/core/crm';
import { contactDetailSnapshot, contactMirrorPage } from '../../src/main/core/contact-mirror';
import type { CenterContact, CenterContactDetail } from '../../src/shared/online-crm';

const id='12345678-1234-1234-1234-123456789abc';
describe('desktop sharing contract',()=>{
 it('validates and routes a decision without leaking action into strict HTTP body',async()=>{
  const request=vi.fn(async()=>success({}));
  const service=createOnlineCrmService({request,login:vi.fn(),logout:vi.fn(),preview:vi.fn(),feed:vi.fn()});
  const input={shareId:id,expectedVersion:2,idempotencyKey:'share-key'};
  expect((await service.decideContactShare({...input,action:'accept'})).ok).toBe(true);
  expect(request).toHaveBeenCalledWith('POST',`/api/crm/contact-shares/${id}/accept`,input,true);
  request.mockClear();
  expect((await service.decideContactShare({...input,action:'delete' as never})).ok).toBe(false);
  expect(request).not.toHaveBeenCalled();
 });
 it('routes validated grants and member directory through center-confirmed requests',async()=>{
  const request=vi.fn(async()=>success({}));
  const service=createOnlineCrmService({request,login:vi.fn(),logout:vi.fn(),preview:vi.fn(),feed:vi.fn()});
  const input={shareId:id,expectedVersion:1,idempotencyKey:'share-key',editableFields:['phone'],canFollowup:false,canChangeStage:false};
  expect((await service.updateContactShare(input)).ok).toBe(true);
  expect(request).toHaveBeenCalledWith('POST',`/api/crm/contact-shares/${id}/update`,input,true);
  await service.contactShareMembers();
  expect(request).toHaveBeenCalledWith('GET','/api/crm/contact-shares/members',undefined,true);
  await service.contactShares({view:'outgoing',contactId:7,customerId:id,limit:50,offset:0});
  expect(request).toHaveBeenCalledWith('GET',expect.stringContaining('contactId=7'),undefined,true);
 });
 it('keeps accepted shared personal contacts in assigned scope and uses latest grants offline',()=>{
  const permissions={editableFields:['phone'],canFollowup:false,canChangeStage:false,canSendMail:true,canShare:false};
  const row={contactId:7,customerId:id,companyId:4,companyName:'Company',origin:'personal',ownerUserId:'other',isShared:true,permissions,canSendMail:true,assignmentStatus:null,tags:[],updatedAt:'2026-10-16T00:00:00Z'} as unknown as CenterContact;
  expect(contactMirrorPage([row],{scope:'assigned',search:'',limit:50,offset:0},'viewer').total).toBe(1);
  expect(contactMirrorPage([row],{scope:'personal',search:'',limit:50,offset:0},'viewer').total).toBe(0);
  const cached={company:{companyId:4,name:'Company'},activities:[],permissions:{...permissions,editableFields:['email']},canSendMail:false} as unknown as CenterContactDetail;
  expect(contactDetailSnapshot(row,cached)).toMatchObject({permissions,canSendMail:true});
 });
});
