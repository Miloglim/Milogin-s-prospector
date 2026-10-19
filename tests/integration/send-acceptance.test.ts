import { describe, it, expect } from 'vitest';
import { Pool } from 'pg';
import { randomUUID, randomBytes } from 'node:crypto';
import { readTestDatabaseConfig } from '../../server/adapters/postgres/config';
import { PostgresLeadRepository } from '../../server/adapters/postgres/lead-repository';
import { PostgresNotificationRepository } from '../../server/adapters/postgres/notification-repository';
import { capabilitiesFor } from '../../server/core/admin';
import { tokenAdapter } from '../../server/adapters/password';
import type { ContactAssignmentRepository } from '../../server/core/contact-assignments';
import type { Result } from '../../server/core/crm';
function unwrap<T>(r:Result<T>):T { if(!r.ok)throw Error(`${r.error.code}: ${r.error.message}`);return r.data; }
describe.runIf(process.env.PROSPECTOR_PG_INTEGRATION==='1')('send acceptance rollback PostgreSQL',()=>{
 it('binds live authorization to immutable late receipts without restoring revoked contact data',async()=>{
  const pool=new Pool(readTestDatabaseConfig()),client=await pool.connect();
  const counts=async()=>(await client.query('SELECT (SELECT count(*) FROM identity.users) AS users,(SELECT count(*) FROM contacts) AS contacts,(SELECT count(*) FROM identity.outbox) AS events')).rows[0];
  const before=await counts();await client.query('BEGIN');
  try {
   let lease=Promise.resolve(), failArchiveAudit=false;
   const facade={options:pool.options,connect:async()=>{const old=lease;let release!:()=>void;lease=new Promise<void>(resolve=>{release=resolve;});await old;return {query:(sql:string,args?:unknown[])=>{if(failArchiveAudit&&sql.includes("VALUES('crm.contact.mail.archived'"))throw Error('rollback audit fixture');return client.query(sql==='BEGIN'?'SAVEPOINT ca_test':sql==='COMMIT'?'RELEASE SAVEPOINT ca_test':sql==='ROLLBACK'?'ROLLBACK TO SAVEPOINT ca_test':sql,args);},release};}} as unknown as Pool;
   const repo=new PostgresLeadRepository(facade,{write:()=>{}}),assignments=repo as unknown as ContactAssignmentRepository;
   expect(typeof assignments.createContactAssignments).toBe('function');
   unwrap(await repo.migrate());
   const actors=[];
   for(const role of ['operations','sales','sales','auditor'] as const){const id=randomUUID(),token=randomBytes(32).toString('base64url');
    await client.query('INSERT INTO identity.users(user_id,display_name) VALUES($1,$2)',[id,`rollback-${id}`]);
    await client.query("INSERT INTO identity.product_grants(user_id,product_id,role) VALUES($1,'crm',$2)",[id,role]);
    await client.query("INSERT INTO identity.product_access(user_id,product_id,scope,capabilities) VALUES($1,'crm',$2,$3)",[id,role==='operations'?'shared':'own',JSON.stringify(capabilitiesFor([role]))]);
    await client.query("INSERT INTO identity.sessions(token_hash,user_id,security_revision,expires_at,client) VALUES($1,$2,1,now()+interval '1 hour','api')",[tokenAdapter.hash(token),id]);actors.push({id,hash:tokenAdapter.hash(token)});
   }
   const [ops,sales,other,auditor]=actors as [{id:string;hash:string},{id:string;hash:string},{id:string;hash:string},{id:string;hash:string}];
   const co=(await client.query("INSERT INTO companies(name,backcheck_data) VALUES('rollback-only-company',$1) RETURNING id",[JSON.stringify({verified:'fixture'})])).rows[0].id,id=randomUUID();
   await client.query("INSERT INTO crm_customers(customer_id,company_id,source,customer_key,source_detail,created_by,origin) VALUES($1,$2,'rollback',$1::uuid::text,'fixture',$3,'operations')",[id,co,ops.id]);
   const contacts:number[]=[];
   for(const name of ['Selected','Sibling']){const ct=(await client.query('INSERT INTO contacts(email,first_name,company_id) VALUES($1,$2,$3) RETURNING id',[`${randomUUID()}@example.invalid`,name,co])).rows[0].id;contacts.push(ct);await client.query('INSERT INTO crm_customer_contacts(customer_id,contact_id) VALUES($1,$2)',[id,ct]);}
   const ref={contactId:contacts[0]!,customerId:id},k=()=>randomUUID();
   const request=unwrap(await repo.createContactAssignments(ops.hash,{contacts:[{...ref,expectedVersion:1}],targetUserId:sales.id,notifyUserIds:[],idempotencyKey:k()})).items[0]!;
   unwrap(await repo.decideContactAssignment(sales.hash,'accept',{requestId:request.requestId,expectedVersion:1,idempotencyKey:k()}));
   const owned=unwrap(await repo.contactDetail(sales.hash,ref));const primary=owned.contact.email!;
   const share=unwrap(await repo.createShare(sales.hash,{...ref,expectedVersion:owned.contact.contactVersion!,targetUserId:other.id,editableFields:[],canFollowup:false,canChangeStage:false,idempotencyKey:k()}));
   unwrap(await repo.decideShare(other.hash,'accept',{shareId:share.shareId,expectedVersion:1,idempotencyKey:k()}));
   const input={sendKey:k(),fromEmail:'collaborator@example.invalid',subject:'accepted fixture',recipients:[{...ref,email:primary}]};
   const sibling={contactId:contacts[1]!,customerId:id};
   const siblingEmail=(await client.query('SELECT email FROM contacts WHERE id=$1',[sibling.contactId])).rows[0].email;
   const authCount=async()=>Number((await client.query('SELECT count(*) AS n FROM crm_send_authorizations')).rows[0].n);
   const preBatch=await authCount();
   expect(await repo.authorizeSend(other.hash,{...input,sendKey:k(),recipients:[...input.recipients,{...sibling,email:siblingEmail}]})).toMatchObject({ok:false});
   expect(await authCount()).toBe(preBatch);
   const grants=unwrap(await repo.authorizeSend(other.hash,input));expect(grants).toHaveLength(1);const grant=grants[0]!;
   expect(unwrap(await repo.authorizeSend(other.hash,input))[0]!.authorizationId).toBe(grant.authorizationId);
   const event={...ref,eventKey:k(),mailboxKey:'opaque-mailbox',messageKey:k(),kind:'sent' as const,direction:'outbound' as const,occurredAt:grant.issuedAt,subject:input.subject,preview:'fixture',fromEmail:input.fromEmail,toEmails:[primary],ccEmails:[],advanceSendStage:true};
   expect(await repo.acceptSend(sales.hash,{authorizationId:grant.authorizationId,event})).toMatchObject({ok:false});
   expect(await repo.acceptSend(other.hash,{authorizationId:grant.authorizationId,event:{...event,subject:'different'}})).toMatchObject({ok:false,error:{code:'CONFLICT'}});
   expect(await repo.acceptSend(other.hash,{authorizationId:grant.authorizationId,event:{...event,toEmails:[primary,'stranger@example.invalid']}})).toMatchObject({ok:false});
   for(const patch of [
    {fromEmail:'stranger@example.invalid'},
    {occurredAt:new Date(new Date(grant.issuedAt).getTime()-61000).toISOString()},
    {occurredAt:new Date(new Date(grant.expiresAt).getTime()+61000).toISOString()},
   ]) expect(await repo.acceptSend(other.hash,{authorizationId:grant.authorizationId,event:{...event,...patch}})).toMatchObject({ok:false});
   const revoked=unwrap(await repo.decideShare(sales.hash,'revoke',{shareId:share.shareId,expectedVersion:2,idempotencyKey:k()}));expect(revoked.status).toBe('revoked');
   expect(await repo.authorizeSend(other.hash,{...input,sendKey:k()})).toMatchObject({ok:false});
   expect(await repo.acceptSend(other.hash,{authorizationId:grant.authorizationId,event:{...event,occurredAt:new Date(new Date(grant.issuedAt).getTime()+6*60*1000).toISOString()}})).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});
   const beforeArchive=(await client.query('SELECT crm_contact_version,stage,status,crm_touch_status FROM contacts WHERE id=$1',[ref.contactId])).rows[0];
   failArchiveAudit=true;
   expect(await repo.acceptSend(other.hash,{authorizationId:grant.authorizationId,event})).toMatchObject({ok:false,error:{code:'DATABASE_ERROR'}});
   failArchiveAudit=false;
   expect((await client.query('SELECT consumed_event_id FROM crm_send_authorizations WHERE authorization_id=$1',[grant.authorizationId])).rows[0].consumed_event_id).toBeNull();
   expect((await client.query('SELECT 1 FROM crm_contact_mail_events WHERE actor_id=$1 AND event_key=$2',[other.id,event.eventKey])).rowCount).toBe(0);
   const receipt=unwrap(await repo.acceptSend(other.hash,{authorizationId:grant.authorizationId,event}));expect(receipt).toMatchObject({duplicate:false,archivedAfterRevocation:true});expect(Object.keys(receipt).sort()).toEqual(['archivedAfterRevocation','duplicate','eventId']);
   expect((await client.query('SELECT crm_contact_version,stage,status,crm_touch_status FROM contacts WHERE id=$1',[ref.contactId])).rows[0]).toEqual(beforeArchive);
   expect(unwrap(await repo.acceptSend(other.hash,{authorizationId:grant.authorizationId,event}))).toMatchObject({eventId:receipt.eventId,duplicate:true,archivedAfterRevocation:true});
   expect(await repo.acceptSend(other.hash,{authorizationId:grant.authorizationId,event:{...event,eventKey:k()}})).toMatchObject({ok:false,error:{code:'CONFLICT'}});
   expect(await repo.contactDetail(other.hash,ref)).toMatchObject({ok:false});
   const ownerInput={...input,sendKey:k(),fromEmail:'owner@example.invalid'};const ownerGrant=unwrap(await repo.authorizeSend(sales.hash,ownerInput))[0]!;
   const ownerEvent={...event,eventKey:k(),messageKey:k(),fromEmail:ownerInput.fromEmail,occurredAt:ownerGrant.issuedAt};
   const current=unwrap(await repo.acceptSend(sales.hash,{authorizationId:ownerGrant.authorizationId,event:ownerEvent}));expect(current.archivedAfterRevocation).toBe(false);expect(unwrap(await repo.contactDetail(sales.hash,ref)).contact.stage).toBe('f1');
   const observedGrant=unwrap(await repo.authorizeSend(sales.hash,{...ownerInput,sendKey:k()}))[0]!;
   const smtpRace={...ownerEvent,eventKey:k(),messageKey:k(),occurredAt:observedGrant.issuedAt};
   const observed={...smtpRace,occurredAt:'2020-01-01T00:00:00.000Z',preview:'IMAP original',advanceSendStage:false};
   const observedFact=unwrap(await repo.recordContactMailEvent(sales.hash,observed));
   const observedVersion=unwrap(await repo.contactDetail(sales.hash,ref)).contact.contactVersion!;
   expect(await repo.acceptSend(sales.hash,{authorizationId:observedGrant.authorizationId,event:smtpRace})).toMatchObject({ok:false,error:{code:'CONFLICT'}});
   for(const patch of [{mailboxKey:'another-mailbox'},{messageKey:'another-message'}]) expect(await repo.acceptSend(sales.hash,{authorizationId:observedGrant.authorizationId,event:smtpRace,observedEvent:{...observed,...patch}})).toMatchObject({ok:false,error:{code:'CONFLICT'}});
   const reconciled=unwrap(await repo.acceptSend(sales.hash,{authorizationId:observedGrant.authorizationId,event:smtpRace,observedEvent:observed}));
   expect(reconciled).toMatchObject({eventId:observedFact.eventId,duplicate:true,archivedAfterRevocation:false});
   expect((await client.query('SELECT occurred_at,preview FROM crm_contact_mail_events WHERE event_id=$1',[observedFact.eventId])).rows[0]).toMatchObject({preview:'IMAP original',occurred_at:new Date(observed.occurredAt)});
   expect(unwrap(await repo.contactDetail(sales.hash,ref)).contact.contactVersion).toBe(observedVersion+1);
   expect(unwrap(await repo.acceptSend(sales.hash,{authorizationId:observedGrant.authorizationId,event:smtpRace,observedEvent:observed})).duplicate).toBe(true);
   expect(await repo.acceptSend(sales.hash,{authorizationId:observedGrant.authorizationId,event:smtpRace,observedEvent:{...observed,preview:'changed'}})).toMatchObject({ok:false,error:{code:'CONFLICT'}});
   const extraGrant=unwrap(await repo.authorizeSend(sales.hash,{...ownerInput,sendKey:k()}))[0]!;expect(await repo.acceptSend(sales.hash,{authorizationId:extraGrant.authorizationId,event:ownerEvent})).toMatchObject({ok:false,error:{code:'CONFLICT'}});
   const expiredInput={...ownerInput,sendKey:k()},expired=unwrap(await repo.authorizeSend(sales.hash,expiredInput))[0]!;await client.query("UPDATE crm_send_authorizations SET issued_at=issued_at-interval '2 hours',expires_at=expires_at-interval '2 hours' WHERE authorization_id=$1",[expired.authorizationId]);expect(await repo.authorizeSend(sales.hash,expiredInput)).toMatchObject({ok:false,error:{code:'CONFLICT'}});
   // Expired authorization upload is still valid for an actual occurrence inside its original window.
   const expiredFact={...ownerEvent,eventKey:k(),messageKey:k(),occurredAt:new Date(new Date(expired.issuedAt).getTime()-2*60*60*1000).toISOString(),advanceSendStage:false};
   expect(unwrap(await repo.acceptSend(sales.hash,{authorizationId:expired.authorizationId,event:expiredFact})).archivedAfterRevocation).toBe(false);
   const batchInput={sendKey:k(),fromEmail:'operations@example.invalid',subject:'subset',recipients:[{...ref,email:primary},{...sibling,email:siblingEmail}],ccEmails:['copy@example.invalid']};
   const batch=unwrap(await repo.authorizeSend(ops.hash,batchInput));
   const batchGrant=batch.find(g=>g.contactId===ref.contactId)!;
   const batchEvent={...event,eventKey:k(),messageKey:k(),fromEmail:batchInput.fromEmail,subject:'subset',occurredAt:batchGrant.issuedAt,toEmails:[primary],ccEmails:['copy@example.invalid'],advanceSendStage:false};
   expect(await repo.acceptSend(ops.hash,{authorizationId:batchGrant.authorizationId,event:{...batchEvent,ccEmails:['other@example.invalid']}})).toMatchObject({ok:false,error:{code:'CONFLICT'}});
   expect(unwrap(await repo.acceptSend(ops.hash,{authorizationId:batchGrant.authorizationId,event:batchEvent})).archivedAfterRevocation).toBe(false);
   const siblingGrant=batch.find(g=>g.contactId===sibling.contactId)!;
   const deletedBefore=(await client.query('UPDATE contacts SET crm_deleted_at=now() WHERE id=$1 RETURNING crm_contact_version,stage,status,crm_touch_status',[sibling.contactId])).rows[0];
   const siblingEvent={...batchEvent,...sibling,eventKey:k(),messageKey:k(),toEmails:[siblingEmail],occurredAt:siblingGrant.issuedAt,advanceSendStage:true};
   expect(unwrap(await repo.acceptSend(ops.hash,{authorizationId:siblingGrant.authorizationId,event:siblingEvent})).archivedAfterRevocation).toBe(true);
   expect((await client.query('SELECT crm_contact_version,stage,status,crm_touch_status FROM contacts WHERE id=$1',[sibling.contactId])).rows[0]).toEqual(deletedBefore);
   // Reviving a contact never makes the historical late receipt a current touch or round advancement.
   await client.query('UPDATE contacts SET crm_deleted_at=NULL WHERE id=$1',[sibling.contactId]);
   const revived=unwrap(await repo.contactDetail(ops.hash,sibling));expect(revived.contact.lastFollowupAt).toBeNull();
   unwrap(await repo.recordContactMailEvent(ops.hash,siblingEvent));
   expect(unwrap(await repo.contactDetail(ops.hash,sibling)).contact.stage).toBe('cold');
   const olderReply={...siblingEvent,eventKey:k(),messageKey:k(),kind:'replied' as const,direction:'inbound' as const,fromEmail:siblingEmail,toEmails:['operations@example.invalid'],ccEmails:[],occurredAt:'2019-01-01T00:00:00.000Z'};
   delete (olderReply as {advanceSendStage?:boolean}).advanceSendStage;
   unwrap(await repo.recordContactMailEvent(ops.hash,olderReply));
   expect(unwrap(await repo.contactDetail(ops.hash,sibling)).contact.status).toBe('replied');
   const existingGrant=unwrap(await repo.authorizeSend(sales.hash,{...ownerInput,sendKey:k()}))[0]!;
   const existingEvent={...ownerEvent,eventKey:k(),messageKey:k(),occurredAt:existingGrant.issuedAt,advanceSendStage:false};
   const existingFact=unwrap(await repo.recordContactMailEvent(sales.hash,existingEvent));
   const changeOwnerGrant=unwrap(await repo.authorizeSend(sales.hash,{...ownerInput,sendKey:k()}))[0]!;
   await client.query("UPDATE crm_contact_assignment_requests SET target_user_id=$1 WHERE request_id=$2",[other.id,request.requestId]);
   expect(unwrap(await repo.acceptSend(sales.hash,{authorizationId:existingGrant.authorizationId,event:existingEvent}))).toMatchObject({eventId:existingFact.eventId,duplicate:true,archivedAfterRevocation:true});
   expect((await client.query('SELECT archive_only FROM crm_contact_mail_events WHERE event_id=$1',[existingFact.eventId])).rows[0].archive_only).toBe(false);
   expect(unwrap(await repo.contactDetail(ops.hash,ref)).contact.lastFollowupAt).toBe(existingEvent.occurredAt);
   const changedBefore=(await client.query('SELECT crm_contact_version,stage,status,crm_touch_status FROM contacts WHERE id=$1',[ref.contactId])).rows[0];
   expect(unwrap(await repo.acceptSend(sales.hash,{authorizationId:changeOwnerGrant.authorizationId,event:{...ownerEvent,eventKey:k(),messageKey:k(),occurredAt:changeOwnerGrant.issuedAt}})).archivedAfterRevocation).toBe(true);
   expect((await client.query('SELECT crm_contact_version,stage,status,crm_touch_status FROM contacts WHERE id=$1',[ref.contactId])).rows[0]).toEqual(changedBefore);
   await client.query('UPDATE identity.sessions SET revoked_at=now() WHERE user_id=$1',[other.id]);expect(await repo.acceptSend(other.hash,{authorizationId:grant.authorizationId,event})).toMatchObject({ok:false,error:{code:'UNAUTHORIZED'}});
  } finally {await client.query('ROLLBACK');expect(await counts()).toEqual(before);client.release();await pool.end();}
 },30000);
});
