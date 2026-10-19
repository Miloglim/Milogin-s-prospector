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
describe.runIf(process.env.PROSPECTOR_PG_INTEGRATION==='1')('mail classification correction rollback PostgreSQL',()=>{
 it('appends revisioned classifications without rewriting facts or contact time',async()=>{
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
   const firstRef={contactId:contacts[1]!,customerId:id};const firstPrimary=(await client.query('SELECT email FROM contacts WHERE id=$1',[firstRef.contactId])).rows[0].email;
   const correctionFirst=unwrap(await repo.recordContactMailEvent(ops.hash,{...firstRef,eventKey:randomUUID(),mailboxKey:'first-only',messageKey:'<correction-before-scan>',kind:'received',direction:'inbound',occurredAt:'2018-01-02T00:00:00.000Z',subject:'fixture',preview:'fixture',fromEmail:firstPrimary,toEmails:['owner@example.invalid'],ccEmails:[],correction:{previousEventKey:null,classification:'other'}}));expect(correctionFirst.contact).toMatchObject({touchStatus:'uncontacted',status:'',lastFollowupAt:null});expect(correctionFirst.event.correctionRevision).toBe(1);
   const firstPayload={...firstRef,eventKey:randomUUID(),mailboxKey:'first-only',messageKey:'<correction-before-scan>',kind:'replied' as const,direction:'inbound' as const,occurredAt:'2018-01-02T00:00:00.000Z',subject:'fixture',preview:'fixture',fromEmail:firstPrimary,toEmails:['owner@example.invalid'],ccEmails:[]};
   const firstReply=unwrap(await repo.recordContactMailEvent(ops.hash,{...firstPayload,correction:{previousEventKey:correctionFirst.event.eventKey,classification:'replied'}}));expect(firstReply.contact).toMatchObject({touchStatus:'replied',lastFollowupAt:firstPayload.occurredAt,lastFollowupNote:'fixture'});expect(firstReply.event.activityId).toBeNull();
   const firstClear=unwrap(await repo.recordContactMailEvent(ops.hash,{...firstPayload,eventKey:randomUUID(),kind:'received',correction:{previousEventKey:firstReply.event.eventKey,classification:'other'}}));expect(firstClear.contact).toMatchObject({touchStatus:'uncontacted',lastFollowupAt:null,lastFollowupNote:null});
   const firstRescan=unwrap(await repo.recordContactMailEvent(ops.hash,{...firstPayload,eventKey:randomUUID()}));expect(firstRescan.event.activityId).toBeNull();expect(firstRescan.contact).toMatchObject({touchStatus:'uncontacted',lastFollowupAt:null});expect((await client.query('SELECT count(*)::int AS n FROM crm_shared_activities WHERE contact_id=$1',[firstRef.contactId])).rows[0].n).toBe(0);
   const contactId=contacts[0]!,ref={contactId,customerId:id},primary=(await client.query('SELECT email FROM contacts WHERE id=$1',[contactId])).rows[0].email;
   const k=()=>randomUUID(),mail={...ref,eventKey:k(),mailboxKey:'own-inbox',messageKey:'<message-one>',kind:'autoreply' as const,direction:'inbound' as const,occurredAt:'2020-01-02T00:00:00.000Z',subject:'original',preview:'original',fromEmail:primary,toEmails:['owner@example.invalid'],ccEmails:[]};
   const initial=unwrap(await repo.recordContactMailEvent(ops.hash,mail));expect(initial.contact.status).toBe('autoreply');
   const corrected={...mail,eventKey:k(),kind:'received' as const,correction:{previousEventKey:null,classification:'other' as const}};
   const otherResult=unwrap(await repo.recordContactMailEvent(ops.hash,corrected));expect(otherResult.contact).toMatchObject({status:'',touchStatus:'uncontacted',stage:'cold'});expect(otherResult.event.correctionRevision).toBe(1);
   expect(unwrap(await repo.recordContactMailEvent(ops.hash,corrected))).toMatchObject({duplicate:true,eventId:otherResult.eventId,event:{correctionRevision:1}});
   expect(await repo.recordContactMailEvent(ops.hash,{...corrected,correction:{previousEventKey:null,classification:'autoreply'},kind:'autoreply'})).toMatchObject({ok:false,error:{code:'CONFLICT'}});
   expect(await repo.recordContactMailEvent(ops.hash,{...corrected,eventKey:k()})).toMatchObject({ok:false,error:{code:'CONFLICT'}});
   const again={...mail,eventKey:k(),correction:{previousEventKey:corrected.eventKey,classification:'autoreply' as const}};
   const againResult=unwrap(await repo.recordContactMailEvent(ops.hash,again));expect(againResult.contact.status).toBe('autoreply');expect(againResult.event.correctionRevision).toBe(2);
   expect(unwrap(await repo.recordContactMailEvent(ops.hash,{...mail,eventKey:k(),kind:'received'})).contact.status).toBe('autoreply');
   const reply={...mail,messageKey:'<message-reply>',eventKey:k(),kind:'replied' as const,occurredAt:'2020-02-02T00:00:00.000Z'};
   const replied=unwrap(await repo.recordContactMailEvent(ops.hash,reply));expect(replied.contact.touchStatus).toBe('replied');
   const removeReply={...reply,eventKey:k(),kind:'received' as const,correction:{previousEventKey:null,classification:'other' as const}};
   const cleared=unwrap(await repo.recordContactMailEvent(ops.hash,removeReply));expect(cleared.contact.touchStatus).toBe('uncontacted');expect(cleared.contact.lastFollowupAt).toBeNull();
   const archived=unwrap(await repo.contactDetail(ops.hash,ref)).activities.find(a=>a.id===replied.event.activityId);expect(archived).toMatchObject({mailEventId:replied.eventId,mailSuperseded:true});
   const otherReply=unwrap(await repo.recordContactMailEvent(ops.hash,{...reply,eventKey:k(),messageKey:'<independent-reply>'}));expect(otherReply.contact.touchStatus).toBe('replied');
   const activityCountBeforeRestore=(await client.query('SELECT count(*)::int AS n FROM crm_shared_activities WHERE contact_id=$1',[contactId])).rows[0].n;
   const restore=unwrap(await repo.recordContactMailEvent(ops.hash,{...reply,eventKey:k(),correction:{previousEventKey:removeReply.eventKey,classification:'replied'}}));
   expect(restore.event.activityId).toBeNull();expect((await client.query('SELECT count(*)::int AS n FROM crm_shared_activities WHERE contact_id=$1',[contactId])).rows[0].n).toBe(activityCountBeforeRestore);expect(restore.contact).toMatchObject({touchStatus:'replied',lastFollowupAt:reply.occurredAt,lastFollowupNote:reply.subject});
   const removeAgain=unwrap(await repo.recordContactMailEvent(ops.hash,{...reply,eventKey:k(),kind:'received',correction:{previousEventKey:restore.event.eventKey,classification:'other'}}));expect(removeAgain.contact.touchStatus).toBe('replied');
   const manual=unwrap(await repo.contactFollowup(ops.hash,{...ref,expectedVersion:removeAgain.contact.contactVersion!,idempotencyKey:k(),note:'newer manual',method:'phone',occurredAt:'2021-01-02T00:00:00.000Z',contactStatus:'contacted'}));
   const activityCountBeforeOld=(await client.query('SELECT count(*)::int AS n FROM crm_shared_activities WHERE contact_id=$1',[contactId])).rows[0].n;
   const oldCorrection=unwrap(await repo.recordContactMailEvent(ops.hash,{...mail,eventKey:k(),kind:'replied',correction:{previousEventKey:again.eventKey,classification:'replied'}}));expect(oldCorrection.contact).toMatchObject({touchStatus:'contacted',status:'reached',lastFollowupAt:'2021-01-02T00:00:00.000Z',lastFollowupNote:'newer manual',stage:'cold'});
   expect((await client.query('SELECT count(*)::int AS n FROM crm_shared_activities WHERE contact_id=$1',[contactId])).rows[0].n).toBe(activityCountBeforeOld);
   expect(await repo.recordContactMailEvent(ops.hash,{...mail,eventKey:k(),kind:'received',occurredAt:'2019-01-02T00:00:00.000Z',correction:{previousEventKey:oldCorrection.event.eventKey,classification:'other'}})).toMatchObject({ok:false,error:{code:'CONFLICT'}});
   expect(await repo.recordContactMailEvent(ops.hash,{...mail,eventKey:k(),kind:'received',fromEmail:'changed@example.invalid',correction:{previousEventKey:oldCorrection.event.eventKey,classification:'other'}})).toMatchObject({ok:false,error:{code:'CONFLICT'}});
   const separate=unwrap(await repo.recordContactMailEvent(ops.hash,{...mail,eventKey:k(),mailboxKey:'another-inbox',kind:'received',correction:{previousEventKey:null,classification:'other'}}));expect(separate.event.correctionRevision).toBe(1);expect(separate.contact.touchStatus).toBe('contacted');
   const atomic={...mail,eventKey:k(),kind:'received' as const,correction:{previousEventKey:oldCorrection.event.eventKey,classification:'other' as const}};
   await client.query("CREATE FUNCTION pg_temp.correction_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture correction outbox'; RETURN NEW; END $$");await client.query("CREATE TRIGGER correction_outbox_fail BEFORE INSERT ON identity.outbox FOR EACH ROW WHEN (NEW.event_type='crm.contact.followup') EXECUTE FUNCTION pg_temp.correction_fail()");
   expect(await repo.recordContactMailEvent(ops.hash,atomic)).toMatchObject({ok:false,error:{code:'DATABASE_ERROR'}});expect((await client.query('SELECT count(*)::int AS n FROM crm_contact_mail_events WHERE event_key=$1',[atomic.eventKey])).rows[0].n).toBe(0);expect(unwrap(await repo.contactDetail(ops.hash,ref)).contact.contactVersion).toBe(separate.contact.contactVersion);
   await client.query('DROP TRIGGER correction_outbox_fail ON identity.outbox');expect(unwrap(await repo.recordContactMailEvent(ops.hash,atomic)).event.correctionRevision).toBe(4);
   expect((await repo.contactDetail(ops.hash,ref)).ok).toBe(true);expect(await repo.recordContactMailEvent(other.hash,{...mail,eventKey:k(),kind:'received',correction:{previousEventKey:null,classification:'other'}})).toMatchObject({ok:false});
   const immutable=(await client.query('SELECT kind,occurred_at FROM crm_contact_mail_events WHERE event_id=$1',[initial.eventId])).rows[0];expect(immutable.kind).toBe('autoreply');expect(new Date(immutable.occurred_at).toISOString()).toBe(mail.occurredAt);
   expect((await client.query('SELECT count(*)::int AS n FROM crm_shared_activities WHERE contact_id=$1',[contactId])).rows[0].n).toBeGreaterThan(2);
  } finally {await client.query('ROLLBACK');expect(await counts()).toEqual(before);client.release();await pool.end();}
 },30000);
});
