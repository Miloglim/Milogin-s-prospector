import { companyUpdate } from '../../server/services/contact-assignments';
import {describe,it,expect} from 'vitest';
import * as validators from '../../server/services/contact-assignments';
import {isContactAssignmentTarget} from '../../server/core/contact-assignments';
describe('contact assignment validation',()=>{
 const id='12345678-1234-1234-1234-123456789abc';
 it('rejects duplicate contacts, authority injection and unlinked fake engagement',()=>{
  const ref={contactId:1,customerId:id,expectedVersion:1};
  expect(validators.contactAssignmentCreate({...{targetUserId:id,notifyUserIds:[],idempotencyKey:'key'},contacts:[ref,ref]})).toMatchObject({ok:false});
  expect(validators.contactUpdate({...ref,idempotencyKey:'key',fields:{ownerUserId:id}})).toMatchObject({ok:false});
  expect(validators.contactUpdate({...ref,idempotencyKey:'key',fields:{tags:['quoting']}})).toMatchObject({ok:true});
  expect(validators.contactUpdate({...ref,idempotencyKey:'key',fields:{preferences:['Santos']}})).toMatchObject({ok:true});
  expect(validators.contactUpdate({...ref,idempotencyKey:'key',fields:{extra:{ownerUserId:id}}})).toMatchObject({ok:false});
  for (const preferences of [[''], ['dup','dup'], Array.from({length:11},(_,i)=>String(i)), ['x'.repeat(201)]]) expect(validators.contactUpdate({...ref,idempotencyKey:'key',fields:{preferences}})).toMatchObject({ok:false});
  expect(validators.contactFollowup({...ref,idempotencyKey:'key',note:'note',method:'note',contactStatus:'contacted'})).toMatchObject({ok:false});
  expect(validators.contactFollowup({...ref,idempotencyKey:'key',note:'note',occurredAt:'2026-02-30T00:00:00Z'})).toMatchObject({ok:false});
 });
 it('uses center role and active development permission for assignment targets',()=>{
  const sales={userId:id,roles:['sales'],capabilities:['leads.develop']};
  expect(isContactAssignmentTarget(sales,'other-actor')).toBe(true);
  expect(isContactAssignmentTarget(sales,id)).toBe(false);
  expect(isContactAssignmentTarget({...sales,roles:['operations']},'other-actor')).toBe(false);
  expect(isContactAssignmentTarget({...sales,active:false},'other-actor')).toBe(false);
  expect(isContactAssignmentTarget({...sales,capabilities:[]},'other-actor')).toBe(false);
 });
 it('accepts an exact request reference while retaining strict query validation',()=>{
  expect(validators.contactAssignmentQuery({view:'incoming',status:'pending',requestId:id})).toMatchObject({ok:true,data:{requestId:id,status:'pending'}});
  expect(validators.contactAssignmentQuery({view:'incoming',requestId:'invalid'})).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});
 });
});

it('validates shared company patch separately and rejects authority injection and malformed reports', () => {
 const input = {contactId:7,customerId:'00000000-0000-4000-8000-000000000007',idempotencyKey:'company-fixture',expectedRevision:'2026-10-15 12:00:00.123456+08',fields:{industry:'Logistics',backcheckData:{summary:'Evidence'}}};
 expect(companyUpdate(input)).toMatchObject({ok:true});
 expect(companyUpdate({...input,fields:{ownerUserId:'other'}})).toMatchObject({ok:false});
 expect(companyUpdate({...input,fields:{backcheckData:[]}})).toMatchObject({ok:false});
 expect(companyUpdate({...input,fields:{}})).toMatchObject({ok:false});
 expect(companyUpdate({...input,expectedRevision:''})).toMatchObject({ok:false});
});
