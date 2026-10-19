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
describe.runIf(process.env.PROSPECTOR_PG_INTEGRATION==='1')('contact sharing rollback PostgreSQL',()=>{
 it('enforces field grants, mail independence, same-record visibility and revoke',async()=>{
  const pool=new Pool(readTestDatabaseConfig()),client=await pool.connect();
  const counts=async()=>(await client.query('SELECT (SELECT count(*) FROM identity.users) AS users,(SELECT count(*) FROM contacts) AS contacts,(SELECT count(*) FROM identity.outbox) AS events')).rows[0];
  const before=await counts();await client.query('BEGIN');
  try {
   let lease=Promise.resolve();
   const facade={options:pool.options,connect:async()=>{const old=lease;let release!:()=>void;lease=new Promise<void>(resolve=>{release=resolve;});await old;return {query:(sql:string,args?:unknown[])=>client.query(sql==='BEGIN'?'SAVEPOINT ca_test':sql==='COMMIT'?'RELEASE SAVEPOINT ca_test':sql==='ROLLBACK'?'ROLLBACK TO SAVEPOINT ca_test':sql,args),release};}} as unknown as Pool;
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
   const ref={customerId:id,contactId:contacts[0]!},k=()=>randomUUID();
   const req=unwrap(await repo.createContactAssignments(ops.hash,{contacts:[{...ref,expectedVersion:1}],targetUserId:sales.id,notifyUserIds:[],idempotencyKey:k()})).items[0]!;
   unwrap(await repo.decideContactAssignment(sales.hash,'accept',{requestId:req.requestId,expectedVersion:1,idempotencyKey:k()}));
   expect(unwrap(await repo.contactDetail(ops.hash,ref)).permissions?.editableFields).toContain('email');
   const base=unwrap(await repo.contactDetail(sales.hash,ref));
   expect(await repo.contactUpdate(sales.hash,{...ref,expectedVersion:base.contact.contactVersion!,idempotencyKey:k(),fields:{email:'changed@example.invalid'}})).toMatchObject({ok:false,error:{code:'FORBIDDEN'}});
   const invite=unwrap(await repo.createShare(sales.hash,{...ref,expectedVersion:base.contact.contactVersion!,targetUserId:other.id,editableFields:['phone'],canFollowup:false,canChangeStage:true,idempotencyKey:k()}));
   expect(invite.status).toBe('pending');expect(await repo.contactDetail(other.hash,ref)).toMatchObject({ok:false});
   expect(unwrap(await repo.shares(other.hash,{view:'incoming',limit:50,offset:0})).total).toBe(1);
   const notifications=new PostgresNotificationRepository(facade,{write:()=>{}});unwrap(await notifications.migrate());unwrap(await notifications.dispatch());
   const notice=unwrap(await notifications.feed(other.hash,{deviceId:'share-test',after:'0',limit:100})).items.find(n=>n.shareId===invite.shareId);expect(notice).toMatchObject({canOpen:true,shareId:invite.shareId,shareStatus:'pending'});expect(notice?.contactId).toBeUndefined();expect(notice?.shareTargetUserId).toBe(other.id);const sourceNotice=unwrap(await notifications.feed(ops.hash,{deviceId:'source-share',after:'0',limit:100})).items.find(n=>n.shareId===invite.shareId);expect(sourceNotice?.canOpen).toBe(true);
   const accepted=unwrap(await repo.decideShare(other.hash,'accept',{shareId:invite.shareId,expectedVersion:1,idempotencyKey:k()}));
   expect(accepted.status).toBe('accepted');
   const detail=unwrap(await repo.contactDetail(other.hash,ref));expect(detail.contact).toMatchObject({isShared:true,ownerUserId:sales.id,canSendMail:true,canFollowup:false});
   expect(detail.permissions?.editableFields).toEqual(['phone']);
   expect(unwrap(await repo.listContacts(other.hash,{search:'rollback-only',scope:'assigned',limit:50,offset:0})).total).toBe(1);
   expect(unwrap(await repo.companies(other.hash,{search:'rollback-only',scope:'assigned',limit:50,offset:0})).items[0]?.contactCount).toBe(1);
   expect(await repo.contactDetail(other.hash,{customerId:id,contactId:contacts[1]!})).toMatchObject({ok:false});
   expect(await repo.contactUpdate(other.hash,{...ref,expectedVersion:detail.contact.contactVersion!,idempotencyKey:k(),fields:{phone:'123',email:'bad@example.invalid'}})).toMatchObject({ok:false,error:{code:'FORBIDDEN'}});
   const patched=unwrap(await repo.contactUpdate(other.hash,{...ref,expectedVersion:detail.contact.contactVersion!,idempotencyKey:k(),fields:{phone:'123'}}));
   expect(patched.contact.phone).toBe('123');
   const staged=unwrap(await repo.contactFollowup(other.hash,{...ref,expectedVersion:patched.contact.contactVersion!,idempotencyKey:k(),note:'跟进阶段：报价中',stage:'quoting',method:'note'}));
   expect(staged.contact.relationshipStage).toBe('quoting');
   expect(await repo.contactFollowup(other.hash,{...ref,expectedVersion:staged.contact.contactVersion!,idempotencyKey:k(),note:'not allowed',method:'phone',contactStatus:'contacted'})).toMatchObject({ok:false,error:{code:'FORBIDDEN'}});
   const narrowed=unwrap(await repo.updateShare(sales.hash,{shareId:invite.shareId,expectedVersion:accepted.version,idempotencyKey:k(),editableFields:[],canFollowup:false,canChangeStage:false}));
   const mailOnly=unwrap(await repo.contactDetail(other.hash,ref));expect(mailOnly.canSendMail).toBe(true);expect(mailOnly.canEdit).toBe(false);
   // A saved request from before narrowing cannot use its old field grant or version.
   expect(mailOnly.permissions).toMatchObject({editableFields:[],canFollowup:false,canChangeStage:false});
   expect(await repo.contactUpdate(other.hash,{...ref,expectedVersion:patched.contact.contactVersion!,idempotencyKey:k(),fields:{phone:'stale-after-narrow'}})).toMatchObject({ok:false,error:{code:'FORBIDDEN'}});
   expect(await repo.contactFollowup(other.hash,{...ref,expectedVersion:staged.contact.contactVersion!,idempotencyKey:k(),note:'stale-stage-after-narrow',stage:'cooperating',method:'note'})).toMatchObject({ok:false,error:{code:'FORBIDDEN'}});

   const mailInput={...ref,eventKey:k(),mailboxKey:'own-account',messageKey:k(),kind:'sent' as const,direction:'outbound' as const,occurredAt:'2020-01-02T00:00:00.000Z',subject:'collaboration fixture',preview:'fixture',fromEmail:'collaborator@example.invalid',toEmails:[mailOnly.contact.email!],ccEmails:[],advanceSendStage:true};
   const sent=unwrap(await repo.recordContactMailEvent(other.hash,mailInput));expect(sent.event.actorId).toBe(other.id);expect(sent.contact.ownerUserId).toBe(sales.id);
   unwrap(await repo.decideShare(sales.hash,'revoke',{shareId:invite.shareId,expectedVersion:narrowed.version,idempotencyKey:k()}));
   expect(await repo.recordContactMailEvent(other.hash,{...mailInput,eventKey:k()})).toMatchObject({ok:false});expect((await client.query('SELECT actor_id FROM crm_contact_mail_events WHERE event_id=$1',[sent.eventId])).rows[0].actor_id).toBe(other.id);
   expect(await repo.contactDetail(other.hash,ref)).toMatchObject({ok:false});expect(unwrap(await repo.listContacts(other.hash,{search:'rollback-only',limit:50,offset:0})).total).toBe(0);
   expect(unwrap(await repo.contactDetail(sales.hash,ref)).contact.ownerUserId).toBe(sales.id);
   const fresh=unwrap(await repo.contactDetail(sales.hash,ref));const second=unwrap(await repo.createShare(sales.hash,{...ref,expectedVersion:fresh.contact.contactVersion!,targetUserId:other.id,editableFields:[],canFollowup:false,canChangeStage:false,idempotencyKey:k()}));unwrap(await repo.decideShare(other.hash,'accept',{shareId:second.shareId,expectedVersion:1,idempotencyKey:k()}));
   await client.query("UPDATE identity.product_access SET capabilities='[]'::jsonb WHERE user_id=$1 AND product_id='crm'",[sales.id]);expect(await repo.contactDetail(other.hash,ref)).toMatchObject({ok:false});expect(unwrap(await repo.listContacts(other.hash,{search:'rollback-only',limit:50,offset:0})).total).toBe(0);
   const leave={shareId:second.shareId,expectedVersion:2,idempotencyKey:k()};expect(unwrap(await repo.decideShare(other.hash,'revoke',leave)).status).toBe('revoked');expect(unwrap(await repo.decideShare(other.hash,'revoke',leave)).status).toBe('revoked');
   // Simulate a center ownership transition inside the rollback fixture only. There is
   // no accepted-contact transfer endpoint; this tests authorization after the change.
   await client.query("UPDATE identity.product_access SET capabilities=$2::jsonb WHERE user_id=$1 AND product_id='crm'",[sales.id,JSON.stringify(capabilitiesFor(['sales']))]);
   await client.query('UPDATE crm_contact_assignment_requests SET target_user_id=$2,version=version+1 WHERE request_id=$1',[req.requestId,other.id]);
   await client.query('UPDATE contacts SET crm_contact_version=crm_contact_version+1 WHERE id=$1',[ref.contactId]);
   expect(await repo.contactDetail(sales.hash,ref)).toMatchObject({ok:false,error:{code:'NOT_FOUND'}});
   expect(await repo.contactUpdate(sales.hash,{...ref,expectedVersion:fresh.contact.contactVersion!,idempotencyKey:k(),fields:{phone:'former-owner-write'}})).toMatchObject({ok:false});
   expect(unwrap(await repo.listContacts(sales.hash,{search:'rollback-only',limit:50,offset:0})).total).toBe(0);
   const newOwner=unwrap(await repo.contactDetail(other.hash,ref));
   expect(newOwner.contact).toMatchObject({contactId:ref.contactId,customerId:ref.customerId,ownerUserId:other.id,isShared:false});
   expect(newOwner.permissions?.editableFields).toContain('phone');
   expect(newOwner.mailEvents.every(event=>!('body' in event)&&!('bodyText' in event)&&!('attachments' in event))).toBe(true);
   expect((await client.query('SELECT actor_id FROM crm_contact_mail_events WHERE event_id=$1',[sent.eventId])).rows[0].actor_id).toBe(other.id);
   const afterTransfer=unwrap(await repo.contactUpdate(other.hash,{...ref,expectedVersion:newOwner.contact.contactVersion!,idempotencyKey:k(),fields:{phone:'new-owner-write'}}));
   expect(afterTransfer.contact.phone).toBe('new-owner-write');

  } finally {await client.query('ROLLBACK');expect(await counts()).toEqual(before);client.release();await pool.end();}
 },30000);
});
