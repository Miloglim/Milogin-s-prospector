import { describe, it, expect } from 'vitest';
import { Pool } from 'pg';
import { randomUUID, randomBytes } from 'node:crypto';
import { readTestDatabaseConfig } from '../../server/adapters/postgres/config';
import { PostgresLeadRepository } from '../../server/adapters/postgres/lead-repository';
import { PostgresNotificationRepository } from '../../server/adapters/postgres/notification-repository';
import {PostgresAdminRepository} from '../../server/adapters/postgres/admin-repository';
import {PostgresTaskRepository} from '../../server/adapters/postgres/task-repository';
import {PostgresOpportunityRepository} from '../../server/adapters/postgres/opportunity-repository';
import {PostgresTeamRepository} from '../../server/adapters/postgres/team-repository';
import { capabilitiesFor } from '../../server/core/admin';
import { tokenAdapter } from '../../server/adapters/password';
import {createLeadService} from '../../server/services/leads';
import {createContactAssignmentService} from '../../server/services/contact-assignments';
import {createContactAssignmentHandler} from '../../server/transport/contact-assignments-http';
import {createServer} from 'node:http';
import type { ContactAssignmentRepository } from '../../server/core/contact-assignments';
import type { Result } from '../../server/core/crm';
import {processExpiredAssignmentsSystemIn,startAssignmentExpiryScheduler} from '../../server/adapters/postgres/contact-assignment-repository';
import {PostgresContactMailAnalysisRepository} from '../../server/adapters/postgres/contact-mail-analysis-repository';
import type {ContactMailRepository} from '../../server/core/contact-mail';
function unwrap<T>(r:Result<T>):T { if(!r.ok)throw Error(`${r.error.code}: ${r.error.message}`);return r.data; }
describe.runIf(process.env.PROSPECTOR_PG_INTEGRATION==='1')('contact acceptance rollback PostgreSQL',()=>{
 it('backfills accepted ownership when 057 is applied after canonical organization',async()=>{
  const pool=new Pool(readTestDatabaseConfig()),client=await pool.connect();await client.query('BEGIN');
  try{
   let lease=Promise.resolve();const facade={options:pool.options,connect:async()=>{const old=lease;let release!:()=>void;lease=new Promise<void>(resolve=>{release=resolve;});await old;return {query:(sql:string,args?:unknown[])=>client.query(sql==='BEGIN'?'SAVEPOINT cp2_backfill':sql==='COMMIT'?'RELEASE SAVEPOINT cp2_backfill':sql==='ROLLBACK'?'ROLLBACK TO SAVEPOINT cp2_backfill':sql,args),release};}} as unknown as Pool;
   const repo=new PostgresLeadRepository(facade,{write:()=>{}});unwrap(await repo.migrate());unwrap(await new PostgresTeamRepository(facade,{write:()=>{}}).migrate());
   const salesId=randomUUID();await client.query('INSERT INTO public.identity_users(user_id,display_name) VALUES($1,$2)',[salesId,'backfill-sales']);const company=(await client.query("INSERT INTO companies(name) VALUES('cp2-backfill-company') RETURNING id")).rows[0].id,customer=randomUUID();await client.query("INSERT INTO crm_customers(customer_id,company_id,source,customer_key,source_detail,created_by,origin) VALUES($1,$2,'backfill',$1::uuid::text,'backfill',$3,'operations')",[customer,company,salesId]);const contact=(await client.query("INSERT INTO contacts(email,first_name,company_id) VALUES('cp2-backfill@example.invalid','Backfill',$1) RETURNING id",[company])).rows[0].id;await client.query('INSERT INTO crm_customer_contacts(customer_id,contact_id) VALUES($1,$2)',[customer,contact]);const request=randomUUID();await client.query("INSERT INTO crm_contact_assignment_requests(request_id,contact_id,customer_id,target_user_id,actor_id,status,version,decided_at) VALUES($1,$2,$3,$4,$4,'accepted',2,now())",[request,contact,customer,salesId]);
   unwrap(await repo.migrateAssignmentState());unwrap(await repo.migrateAssignmentState());
   expect((await client.query('SELECT owner_user_id AS "ownerUserId",assignment_request_id AS "assignmentRequestId" FROM crm_contact_ownership WHERE contact_id=$1 AND ended_at IS NULL',[contact])).rows[0]).toEqual({ownerUserId:salesId,assignmentRequestId:request});expect((await client.query('SELECT expires_at>created_at+interval \'6 days\' AS ok FROM crm_contact_assignment_requests WHERE request_id=$1',[request])).rows[0].ok).toBe(true);expect((await client.query("SELECT count(*)::int AS count FROM crm_schema_migrations WHERE version='057-contact-assignment-state'")).rows[0].count).toBe(1);
  }finally{await client.query('ROLLBACK');client.release();await pool.end();}
 },30000);

 it('keeps sibling contacts private, requires acceptance and atomically records contact-only followup',async()=>{
  const pool=new Pool(readTestDatabaseConfig()),client=await pool.connect();
  const counts=async()=>(await client.query('SELECT (SELECT count(*) FROM public.identity_users) AS users,(SELECT count(*) FROM contacts) AS contacts,(SELECT count(*) FROM public.identity_outbox) AS events')).rows[0];
  const before=await counts();await client.query('BEGIN');
  try {
   let lease=Promise.resolve();
   const facade={options:pool.options,connect:async()=>{const old=lease;let release!:()=>void;lease=new Promise<void>(resolve=>{release=resolve;});await old;return {query:(sql:string,args?:unknown[])=>client.query(sql==='BEGIN'?'SAVEPOINT ca_test':sql==='COMMIT'?'RELEASE SAVEPOINT ca_test':sql==='ROLLBACK'?'ROLLBACK TO SAVEPOINT ca_test':sql,args),release};}} as unknown as Pool;
   const repo=new PostgresLeadRepository(facade,{write:()=>{}}),assignments=repo as unknown as ContactAssignmentRepository;
   expect(typeof assignments.createContactAssignments).toBe('function');
   unwrap(await repo.migrate());
   unwrap(await new PostgresTeamRepository(facade,{write:()=>{}}).migrate());
   unwrap(await repo.migrateAssignmentState());
   const actors=[];
   for(const role of ['operations','operations','sales','sales','auditor'] as const){const id=randomUUID(),token=randomBytes(32).toString('base64url');
    await client.query('INSERT INTO public.identity_users(user_id,display_name) VALUES($1,$2)',[id,`rollback-${id}`]);
    await client.query("INSERT INTO public.identity_product_grants(user_id,product_id,role) VALUES($1,'crm',$2)",[id,role]);
    await client.query("INSERT INTO public.identity_product_access(user_id,product_id,scope,capabilities) VALUES($1,'crm',$2,$3)",[id,role==='operations'?'shared':'own',JSON.stringify(capabilitiesFor([role]))]);
    await client.query("INSERT INTO public.identity_sessions(token_hash,user_id,security_revision,expires_at,client) VALUES($1,$2,1,now()+interval '1 hour','api')",[tokenAdapter.hash(token),id]);actors.push({id,hash:tokenAdapter.hash(token)});
   }
   const [ops,otherOps,sales,other,auditor]=actors as [{id:string;hash:string},{id:string;hash:string},{id:string;hash:string},{id:string;hash:string},{id:string;hash:string}];
   const co=(await client.query("INSERT INTO companies(name,backcheck_data) VALUES('rollback-only-company',$1) RETURNING id",[JSON.stringify({verified:'fixture'})])).rows[0].id,id=randomUUID(),batchSource=`fixture-${id}`;
   await client.query("INSERT INTO crm_customers(customer_id,company_id,source,customer_key,source_detail,created_by,origin) VALUES($1,$2,'rollback',$1::uuid::text,$4,$3,'operations')",[id,co,ops.id,batchSource]);
   const contacts:number[]=[],contactEmails:string[]=[];
   for(const name of ['Selected','Sibling']){const email=`${randomUUID()}@example.invalid`;contactEmails.push(email);const ct=(await client.query("INSERT INTO contacts(email,first_name,company_id,source_level1,source_detail) VALUES($1,$2,$3,'Trade show',$4) RETURNING id",[email,name,co,batchSource])).rows[0].id;contacts.push(ct);await client.query('INSERT INTO crm_customer_contacts(customer_id,contact_id) VALUES($1,$2)',[id,ct]);}
   const batchGroup=unwrap(await repo.listContactGroups(ops.hash,{dimension:'batch',scope:'all',search:batchSource,limit:24,offset:0})).items[0]!;
   expect(batchGroup).toMatchObject({label:batchSource,sourceLevel1:['Trade show']});expect(batchGroup.latestImportedAt).toEqual(expect.any(String));
   expect(unwrap(await repo.listContactGroups(ops.hash,{dimension:'batch',scope:'all',search:contactEmails[0]!,limit:24,offset:0})).items[0]).toMatchObject({label:batchSource});
   const companyGroup=unwrap(await repo.listContactGroups(ops.hash,{dimension:'company',scope:'all',search:'rollback-only-company',limit:24,offset:0})).items[0]!;
   expect(companyGroup).toMatchObject({label:'rollback-only-company',count:2,companyCount:1,countryCount:0,touchedCount:0,companies:['rollback-only-company'],sourceLevel1:['Trade show']});expect(companyGroup.latestImportedAt).toEqual(expect.any(String));expect(unwrap(await repo.listContacts(ops.hash,{search:'',limit:50,offset:0,groupDimension:'company',groupKey:companyGroup.key})).total).toBe(2);
   const companyRef={customerId:id,contactId:contacts[0]!};
   expect(unwrap(await repo.listContacts(otherOps.hash,{search:'rollback-only',limit:50,offset:0})).total).toBe(2);
   expect(unwrap(await assignments.contactDetail(otherOps.hash,companyRef))).toMatchObject({canEdit:true,canFollowup:true,company:{canEdit:true}});
   const initialCompany=unwrap(await assignments.contactDetail(ops.hash,companyRef)).company;
   expect(initialCompany).toMatchObject({canEdit:true,industry:null});
   const companyPatch={...companyRef,expectedRevision:initialCompany.revision!,idempotencyKey:randomUUID(),fields:{industry:'Freight',size:'20',country:'Brazil'}};
   expect(unwrap(await assignments.companyUpdate!(ops.hash,companyPatch)).company).toMatchObject({industry:'Freight',size:'20',country:'Brazil'});
   expect(unwrap(await assignments.companyUpdate!(ops.hash,companyPatch)).company.industry).toBe('Freight');
   expect(await assignments.companyUpdate!(ops.hash,{...companyPatch,idempotencyKey:randomUUID()})).toMatchObject({ok:false,error:{code:'CONFLICT'}});
   expect(await assignments.companyUpdate!(sales.hash,{...companyPatch,idempotencyKey:randomUUID()})).toMatchObject({ok:false,error:{code:'FORBIDDEN'}});
   const privateCompany=(await client.query("INSERT INTO companies(name) VALUES('private-only-company') RETURNING id")).rows[0].id;
   const privateId=randomUUID(),privateContact=(await client.query('INSERT INTO contacts(email,first_name,company_id) VALUES($1,$2,$3) RETURNING id',[`${randomUUID()}@example.invalid`,'Private',privateCompany])).rows[0].id;
   await client.query("INSERT INTO crm_customers(customer_id,company_id,source,customer_key,source_detail,created_by,origin,state,owner_user_id) VALUES($1,$2,'rollback',$1::uuid::text,'private',$3,'personal','owned',$3)",[privateId,privateCompany,sales.id]);
   await client.query('INSERT INTO crm_customer_contacts(customer_id,contact_id) VALUES($1,$2)',[privateId,privateContact]);
   expect(await assignments.contactDetail(otherOps.hash,{customerId:privateId,contactId:privateContact})).toMatchObject({ok:false,error:{code:'NOT_FOUND'}});
   expect(unwrap(await repo.listContacts(otherOps.hash,{search:'Private',limit:50,offset:0})).total).toBe(0);
   const selected=contacts[0]!,sibling=contacts[1]!,input={contacts:[{customerId:id,contactId:selected,expectedVersion:1},{customerId:id,contactId:sibling,expectedVersion:1}],targetUserId:sales.id,idempotencyKey:randomUUID()};
   const created=unwrap(await assignments.createContactAssignments(ops.hash,input));const request=created.items[0]!,siblingRequest=created.items[1]!;
   expect(created.items).toHaveLength(2);expect(siblingRequest.groupId).toBe(request.groupId);
   expect(request.status).toBe('pending');expect(request.email).toBeNull();
   expect(unwrap(await assignments.contactAssignments(otherOps.hash,{view:'outgoing',status:'pending',search:'',limit:50,offset:0})).items).toContainEqual(expect.objectContaining({requestId:request.requestId,canCancel:true}));
   expect(unwrap(await assignments.contactDetail(ops.hash,{customerId:id,contactId:selected})).canAssign).toBe(false);
   expect(unwrap(await assignments.createContactAssignments(ops.hash,input)).items[0]!.requestId).toBe(request.requestId);
   expect(await assignments.contactDetail(sales.hash,{customerId:id,contactId:selected})).toMatchObject({ok:false,error:{code:'NOT_FOUND'}});
   expect(unwrap(await repo.listContacts(sales.hash,{search:'rollback-only',limit:50,offset:0})).total).toBe(0);
   expect(await assignments.decideContactAssignment(other.hash,'accept',{requestId:request.requestId,expectedVersion:1,idempotencyKey:randomUUID()})).toMatchObject({ok:false,error:{code:'NOT_FOUND'}});
   const notifications=new PostgresNotificationRepository(facade,{write:()=>{}});unwrap(await notifications.migrate());unwrap(await notifications.dispatch());
   const notices=unwrap(await notifications.feed(sales.hash,{deviceId:'rollback',after:'0',limit:100,latest:true})).items.filter(x=>x.assignmentGroupId===request.groupId);
   expect(notices).toHaveLength(1);expect(notices[0]).toMatchObject({canOpen:true,assignmentGroupCount:2,summary:{companyName:'rollback-only-company'}});expect(JSON.stringify(notices[0])).not.toContain('@example.invalid');
   const decision={requestId:request.requestId,expectedVersion:1,idempotencyKey:randomUUID()};
   const accepted=unwrap(await assignments.decideContactAssignment(sales.hash,'accept',decision));expect(accepted.status).toBe('accepted');
   const pendingGroup=unwrap(await assignments.contactAssignmentGroups(sales.hash,{view:'incoming',status:'pending',search:'',limit:50,offset:0})).items.find(row=>row.groupId===request.groupId)!;
   expect(pendingGroup).toMatchObject({total:2,pending:1,accepted:1,canAcceptAll:true});
   const grouped=unwrap(await assignments.decideContactAssignmentGroup(sales.hash,'reject',{groupId:request.groupId,idempotencyKey:randomUUID()}));expect(grouped.items.map(row=>row.status).sort()).toEqual(['accepted','rejected']);
   const exact=unwrap(await assignments.contactAssignments(sales.hash,{view:'incoming',status:'pending',requestId:request.requestId,search:'',limit:50,offset:0}));
   expect(exact).toMatchObject({total:1,items:[{requestId:request.requestId,status:'accepted'}]});
   expect(unwrap(await assignments.contactAssignments(other.hash,{view:'incoming',status:'pending',requestId:request.requestId,search:'',limit:50,offset:0}))).toEqual({total:0,items:[]});
   expect(unwrap(await assignments.contactAssignments(sales.hash,{view:'incoming',status:'pending',requestId:randomUUID(),search:'',limit:50,offset:0}))).toEqual({total:0,items:[]});
   expect(unwrap(await assignments.decideContactAssignment(sales.hash,'accept',decision))).toEqual(accepted);
   expect(await assignments.decideContactAssignment(ops.hash,'cancel',{...decision,idempotencyKey:randomUUID(),expectedVersion:2})).toMatchObject({ok:false,error:{code:'CONFLICT'}});
   expect((await client.query('SELECT owner_user_id,state FROM crm_customers WHERE customer_id=$1',[id])).rows[0]).toEqual({owner_user_id:null,state:'draft'});
   const page=unwrap(await repo.listContacts(sales.hash,{search:'rollback-only',limit:50,offset:0,scope:'assigned'}));expect(page.total).toBe(1);expect(page.items[0]!.contactId).toBe(selected);
   expect(await assignments.contactDetail(sales.hash,{customerId:id,contactId:sibling})).toMatchObject({ok:false,error:{code:'NOT_FOUND'}});
   expect(await repo.detail(sales.hash,id)).toMatchObject({ok:false,error:{code:'NOT_FOUND'}});
   const tasks=new PostgresTaskRepository(facade,{write:()=>{}}),opportunities=new PostgresOpportunityRepository(facade,{write:()=>{}});
   unwrap(await tasks.migrate());unwrap(await opportunities.migrate());
   const task=unwrap(await tasks.create(ops.hash,{customerId:id,title:'company task private',dueAt:'2026-10-15T12:00:00Z',expectedCustomerVersion:1,idempotencyKey:randomUUID()}));
   const opportunity=unwrap(await opportunities.create(ops.hash,{customerId:id,title:'company opportunity private',expectedCustomerVersion:1,idempotencyKey:randomUUID()}));
   expect(unwrap(await tasks.detail(otherOps.hash,task.taskId)).canManage).toBe(true);
   expect(unwrap(await opportunities.detail(otherOps.hash,opportunity.opportunityId)).canManage).toBe(true);
   expect(await tasks.detail(sales.hash,task.taskId)).toMatchObject({ok:false,error:{code:'NOT_FOUND'}});
   expect(unwrap(await tasks.list(sales.hash,{customerId:id,limit:50,offset:0})).total).toBe(0);
   expect(await opportunities.detail(sales.hash,opportunity.opportunityId)).toMatchObject({ok:false,error:{code:'NOT_FOUND'}});
   expect(await opportunities.list(sales.hash,{customerId:id,limit:50,offset:0})).toMatchObject({ok:false,error:{code:'NOT_FOUND'}});
   expect(await repo.assign(ops.hash,{customerId:id,expectedVersion:1,idempotencyKey:randomUUID(),salesUserId:other.id,notifyUserIds:[]})).toMatchObject({ok:false});
   const opsDetail=unwrap(await assignments.contactDetail(ops.hash,{customerId:id,contactId:selected}));unwrap(await assignments.contactUpdate(ops.hash,{customerId:id,contactId:selected,expectedVersion:opsDetail.contact.contactVersion!,idempotencyKey:randomUUID(),fields:{tags:['priority']}}));
   const otherOpsDetail=unwrap(await assignments.contactDetail(otherOps.hash,{customerId:id,contactId:selected}));
   expect(unwrap(await assignments.contactUpdate(otherOps.hash,{customerId:id,contactId:selected,expectedVersion:otherOpsDetail.contact.contactVersion!,idempotencyKey:randomUUID(),fields:{title:'Shared operations'}})).contact.title).toBe('Shared operations');
   const detail=unwrap(await assignments.contactDetail(sales.hash,{customerId:id,contactId:selected}));expect(detail).toMatchObject({mailAvailable:true,canEdit:true,company:{backcheckData:{verified:'fixture'}}});
   await client.query("UPDATE contacts SET extra=extra || '{\"provenance\":\"keep\"}'::jsonb WHERE id=$1",[selected]);
   const updated=unwrap(await assignments.contactUpdate(sales.hash,{customerId:id,contactId:selected,expectedVersion:detail.contact.contactVersion!,idempotencyKey:randomUUID(),fields:{lastName:'Preserved',phone:'123',preferences:['Santos']}}));
   expect(updated.contact).toMatchObject({lastName:'Preserved',phone:'123',tags:['priority'],touchStatus:'uncontacted',extra:{preferences:['Santos'],provenance:'keep'}});
   expect(unwrap(await repo.listContacts(sales.hash,{search:'rollback-only',limit:50,offset:0,followupOnly:true})).total).toBe(0);
   const followupAt='2020-01-02T12:00:00.000Z';
   const followup=unwrap(await assignments.contactFollowup(sales.hash,{customerId:id,contactId:selected,expectedVersion:updated.contact.contactVersion!,idempotencyKey:randomUUID(),note:'contact only',method:'phone',occurredAt:followupAt,contactStatus:'contacted',stage:'quoting'}));
   expect(followup.contact.tags).toEqual(['priority']);
   expect(followup.contact.relationshipStage).toBe('quoting');
   expect(followup.activities[0]).toMatchObject({contactId:selected,note:'contact only'});expect(unwrap(await repo.listContacts(sales.hash,{search:'rollback-only',limit:50,offset:0,followupOnly:true,crmStage:'quoting'})).total).toBe(1);
   await client.query("INSERT INTO crm_shared_activities(customer_id,interaction_id,actor_id,note,method,occurred_at,contact_id,opportunity_id) VALUES($1,NULL,$2,'private opportunity note','phone','2021-01-01T00:00:00Z',$3,$4),($1,NULL,$2,'later annotation','note','2022-01-01T00:00:00Z',$3,NULL)",[id,ops.id,selected,opportunity.opportunityId]);
   const recent=unwrap(await repo.listContacts(sales.hash,{search:'rollback-only',scope:'assigned',limit:50,offset:0,followupOnly:true}));
   expect(recent.items).toHaveLength(1);expect(recent.items[0]).toMatchObject({contactId:selected,lastFollowupAt:followupAt,lastFollowupNote:'contact only'});
   expect(unwrap(await assignments.contactDetail(ops.hash,{customerId:id,contactId:sibling})).contact).toMatchObject({lastFollowupAt:null,lastFollowupNote:null});
   expect((await client.query('SELECT relationship_stage FROM crm_customers WHERE customer_id=$1',[id])).rows[0].relationship_stage).toBe('cold');
   expect(unwrap(await assignments.contactDetail(ops.hash,{customerId:id,contactId:sibling})).activities).toHaveLength(0);
   const second=unwrap(await assignments.createContactAssignments(ops.hash,{...input,contacts:[{customerId:id,contactId:sibling,expectedVersion:1}],idempotencyKey:randomUUID()})).items[0]!;
   unwrap(await assignments.decideContactAssignment(sales.hash,'reject',{requestId:second.requestId,expectedVersion:1,idempotencyKey:randomUUID()}));
   const third=unwrap(await assignments.createContactAssignments(ops.hash,{...input,contacts:[{customerId:id,contactId:sibling,expectedVersion:1}],idempotencyKey:randomUUID()})).items[0]!;
   unwrap(await assignments.decideContactAssignment(ops.hash,'cancel',{requestId:third.requestId,expectedVersion:1,idempotencyKey:randomUUID()}));
   expect((await client.query("SELECT count(*)::int n FROM public.identity_outbox WHERE payload->>'requestId'=$1 AND event_type='crm.contact.assignment.accepted'",[request.requestId])).rows[0].n).toBe(1);
   const race=await Promise.all([sales,other].map(target=>assignments.createContactAssignments(ops.hash,{...input,targetUserId:target.id,contacts:[{customerId:id,contactId:sibling,expectedVersion:1}],idempotencyKey:randomUUID()})));
   expect(race.filter(r=>r.ok)).toHaveLength(1);
   const racing=race.find(r=>r.ok)!;if(!racing.ok)throw Error('missing race winner');const fourth=racing.data.items[0]!;
   await client.query("CREATE FUNCTION pg_temp.ca_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture outbox'; RETURN NEW; END $$");
   await client.query(`CREATE TRIGGER ca_test_outbox_fail BEFORE INSERT ON public.identity_outbox FOR EACH ROW WHEN (NEW.event_type='crm.contact.assignment.accepted') EXECUTE FUNCTION pg_temp.ca_fail()`);
   const target=fourth.targetUserId===sales.id?sales:other,atomicDecision={requestId:fourth.requestId,expectedVersion:1,idempotencyKey:randomUUID()};
   expect(await assignments.decideContactAssignment(target.hash,'accept',atomicDecision)).toMatchObject({ok:false,error:{code:'DATABASE_ERROR'}});
   expect((await client.query('SELECT status FROM crm_contact_assignment_requests WHERE request_id=$1',[fourth.requestId])).rows[0].status).toBe('pending');
   expect((await client.query('SELECT crm_contact_version FROM contacts WHERE id=$1',[sibling])).rows[0].crm_contact_version).toBe(1);
   await client.query('DROP TRIGGER ca_test_outbox_fail ON public.identity_outbox');unwrap(await assignments.decideContactAssignment(target.hash,'accept',atomicDecision));
   const server=createServer(createContactAssignmentHandler(createContactAssignmentService(assignments,tokenAdapter)));await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
   try {const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    const token=(await client.query('SELECT token_hash FROM public.identity_sessions WHERE user_id=$1',[sales.id])).rows[0].token_hash;
    const httpService=createContactAssignmentService(assignments,{...tokenAdapter,hash:()=>token});
    const http=createServer(createContactAssignmentHandler(httpService));await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve));
    try {const authenticated=`http://127.0.0.1:${(http.address() as {port:number}).port}`,headers={Authorization:`Bearer ${'a'.repeat(43)}`,'Content-Type':'application/json'};
     expect((await (await fetch(`${authenticated}/api/crm/contacts/${selected}?customerId=${id}`,{headers})).json()).data.contact.contactId).toBe(selected);
     expect((await (await fetch(`${authenticated}/api/crm/contacts/${selected}/update`,{method:'POST',headers,body:JSON.stringify({customerId:id,contactId:sibling,expectedVersion:1,idempotencyKey:randomUUID(),fields:{phone:'bad'}})})).json()).ok).toBe(false);
     expect((await (await fetch(`${authenticated}/api/crm/contact-assignments?view=incoming&status=accepted&limit=1`,{headers})).json()).data.total).toBeGreaterThan(0);
    } finally {http.closeAllConnections();await new Promise<void>(resolve=>http.close(()=>resolve()));}
    expect((await (await fetch(`${base}/api/crm/contacts/${selected}?customerId=${id}`)).json()).ok).toBe(false);
   } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
   await client.query('UPDATE public.identity_users SET identity_admin=true WHERE user_id=$1',[auditor.id]);
   const adminHash=tokenAdapter.hash(randomBytes(32).toString('base64url'));await client.query("INSERT INTO public.identity_sessions(token_hash,user_id,security_revision,expires_at,client) VALUES($1,$2,1,now()+interval '1 hour','browser')",[adminHash,auditor.id]);
   const adminRepo=new PostgresAdminRepository(facade,{write:()=>{}});
   expect(await adminRepo.mutate(adminHash,{action:'user.delete',userId:sales.id,revision:1,reason:'rollback only'})).toMatchObject({ok:false,error:{code:'CONFLICT'}});
   expect(await adminRepo.mutate(adminHash,{action:'user.delete',userId:ops.id,revision:1,reason:'rollback only'})).toMatchObject({ok:false,error:{code:'CONFLICT'}});
   const leadService=createLeadService(repo,{...tokenAdapter,hash:()=>ops.hash});
   const source=`rollback-import-${randomUUID()}`,workbook={source,sourceDetail:'fixture',kind:'personal',idempotencyKey:randomUUID(),rows:[{entity:'customer',sourceRef:'company',companyName:source,sheetName:'customers',rowNumber:1,rawRow:{}},{entity:'contact',sourceRef:'one',customerRef:'company',firstName:'Full',lastName:'Name',email:`${randomUUID()}@example.invalid`,title:'Manager',phone:'123',linkedinUrl:'https://example.invalid',country:'Brazil',language:'PT',clientType:'agent',stage:'f2',status:'ready',tags:['quoting'],sheetName:'contacts',rowNumber:1,rawRow:{original:'preserved'}}]};
   const imported=unwrap(await leadService.importWorkbook('a'.repeat(43),workbook));expect(imported.rows.map(r=>r.status)).toEqual(['created','appended']);
   const importedId=imported.rows[0]!.customerId!,importedContact=unwrap(await repo.listContacts(ops.hash,{search:source,limit:50,offset:0})).items[0]!;
   expect(importedContact).toMatchObject({customerId:importedId,origin:'operations',ownerUserId:null,firstName:'Full',lastName:'Name',linkedinUrl:'https://example.invalid',language:'PT',clientType:'agent',stage:'f2',status:'ready',tags:['quoting'],touchStatus:'uncontacted'});
   const salesService=createLeadService(repo,{...tokenAdapter,hash:()=>sales.hash});
   const salesImport=unwrap(await salesService.importWorkbook('a'.repeat(43),{...workbook,source:source+'-sales',kind:'operations',idempotencyKey:randomUUID(),rows:[{...workbook.rows[0],companyName:source+'-sales'},{...workbook.rows[1],email:`${randomUUID()}@example.invalid`}]}));
   expect((await client.query('SELECT origin,owner_user_id FROM crm_customers WHERE customer_id=$1',[salesImport.rows[0]!.customerId])).rows[0]).toEqual({origin:'personal',owner_user_id:sales.id});
   const flatSource=source+'-flat',flat=unwrap(await salesService.importRows('a'.repeat(43),{source:flatSource,sourceDetail:'flat fixture',kind:'operations',idempotencyKey:randomUUID(),rows:[{customerKey:randomUUID(),companyName:flatSource,email:`${randomUUID()}@example.invalid`,firstName:'Flat',lastName:'Person',title:'Routing',phone:'456',linkedinUrl:'https://example.invalid/flat',country:'Chile',language:'ES',clientType:'agent',stage:'f3',status:'ready',tags:['trial'],rawRow:{original:'safe',owner_user_id:other.id,origin:'operations'}}]}));
   expect(flat.rows[0]!.status).toBe('created');
   expect(unwrap(await repo.listContacts(sales.hash,{search:flatSource,limit:50,offset:0})).items[0]).toMatchObject({origin:'personal',ownerUserId:sales.id,firstName:'Flat',lastName:'Person',title:'Routing',phone:'456',linkedinUrl:'https://example.invalid/flat',country:'Chile',language:'ES',clientType:'agent',stage:'f3',status:'ready',tags:['trial'],touchStatus:'uncontacted'});
  } finally {await client.query('ROLLBACK');expect(await counts()).toEqual(before);client.release();await pool.end();}
 },30000);

 it('closes assignment ownership, transfer, monitoring and timeout states on canonical organization',async()=>{
  const pool=new Pool(readTestDatabaseConfig()),client=await pool.connect();
  const before=(await client.query('SELECT count(*)::int AS count FROM public.identity_outbox')).rows[0].count;
  await client.query('BEGIN');
  try{
   let lease=Promise.resolve();
   const facade={options:pool.options,connect:async()=>{const old=lease;let release!:()=>void;lease=new Promise<void>(resolve=>{release=resolve;});await old;return {query:(sql:string,args?:unknown[])=>client.query(sql==='BEGIN'?'SAVEPOINT cp2_test':sql==='COMMIT'?'RELEASE SAVEPOINT cp2_test':sql==='ROLLBACK'?'ROLLBACK TO SAVEPOINT cp2_test':sql,args),release};}} as unknown as Pool;
   const repo=new PostgresLeadRepository(facade,{write:()=>{}});unwrap(await repo.migrate());unwrap(await new PostgresTeamRepository(facade,{write:()=>{}}).migrate());unwrap(await repo.migrateAssignmentState());unwrap(await repo.migrateLeadMatch());const analysisRepo=new PostgresContactMailAnalysisRepository(facade,{write:()=>{}});unwrap(await analysisRepo.migrate());
   const actors:Array<{id:string;hash:string}>=[];
   for(const role of ['operations','operations','sales','sales','sales','admin'] as const){const id=randomUUID(),token=randomBytes(32).toString('base64url');await client.query('INSERT INTO public.identity_users(user_id,display_name) VALUES($1,$2)',[id,`cp2-${id}`]);await client.query("INSERT INTO public.identity_product_grants(user_id,product_id,role) VALUES($1,'crm',$2)",[id,role]);await client.query("INSERT INTO public.identity_product_access(user_id,product_id,scope,capabilities) VALUES($1,'crm',$2,$3)",[id,role==='operations'?'shared':role==='admin'?'summary':'own',JSON.stringify(capabilitiesFor([role]))]);await client.query("INSERT INTO public.identity_sessions(token_hash,user_id,security_revision,expires_at,client) VALUES($1,$2,1,now()+interval '1 hour','api')",[tokenAdapter.hash(token),id]);actors.push({id,hash:tokenAdapter.hash(token)});}
   const [ops,otherOps,leader,member,peer,superadmin]=actors as [typeof actors[number],typeof actors[number],typeof actors[number],typeof actors[number],typeof actors[number],typeof actors[number]];
   const companyId=(await client.query("SELECT unit_id FROM crm_org_units WHERE kind='company'")).rows[0].unit_id;
   const operationsUnit=(await client.query("INSERT INTO crm_org_units(kind,parent_unit_id,name,created_by) VALUES('operations_group',$1,'CP2 Operations',$2) RETURNING unit_id",[companyId,ops.id])).rows[0].unit_id;
   const salesTeam=(await client.query("INSERT INTO crm_org_units(kind,parent_unit_id,name,created_by) VALUES('sales_team',$1,'CP2 Sales',$2) RETURNING unit_id",[operationsUnit,ops.id])).rows[0].unit_id;
   await client.query("INSERT INTO crm_org_assignments(user_id,unit_id,role,is_primary) VALUES($1,$2,'leader',true)",[ops.id,operationsUnit]);
   await client.query("INSERT INTO crm_org_assignments(user_id,unit_id,role,is_primary) VALUES($1,$2,'leader',true)",[leader.id,salesTeam]);
   await client.query("INSERT INTO crm_org_assignments(user_id,unit_id,role) VALUES($1,$2,'member'),($3,$2,'member')",[member.id,salesTeam,peer.id]);

   async function contactFixture(label:string){const company=(await client.query('INSERT INTO companies(name) VALUES($1) RETURNING id',[`cp2-${label}-${randomUUID()}`])).rows[0].id,customer=randomUUID();await client.query("INSERT INTO crm_customers(customer_id,company_id,source,customer_key,source_detail,created_by,origin) VALUES($1,$2,'cp2',$1::uuid::text,'cp2',$3,'operations')",[customer,company,ops.id]);const contact=(await client.query('INSERT INTO contacts(email,first_name,company_id,source_detail) VALUES($1,$2,$3,$4) RETURNING id,crm_contact_version AS version',[`${randomUUID()}@example.invalid`,label,company,'cp2'])).rows[0];await client.query('INSERT INTO crm_customer_contacts(customer_id,contact_id) VALUES($1,$2)',[customer,contact.id]);return {contactId:contact.id as number,customerId:customer,expectedVersion:contact.version as number};}
   const memberContact=await contactFixture('Member contact');
   const memberRequest=unwrap(await repo.createContactAssignments(ops.hash,{targetUserId:member.id,idempotencyKey:randomUUID(),contacts:[memberContact]})).items[0]!;
   const oversightPage=unwrap(await repo.contactAssignments(superadmin.hash,{view:'outgoing',status:'pending',search:'',limit:50,offset:0}));expect(oversightPage.items.find(row=>row.requestId===memberRequest.requestId)).toMatchObject({canCancel:false});expect(await repo.decideContactAssignment(superadmin.hash,'cancel',{requestId:memberRequest.requestId,expectedVersion:memberRequest.version,idempotencyKey:randomUUID()})).toMatchObject({ok:false,error:{code:'NOT_FOUND'}});
   const notification=(await client.query('SELECT notify_user_ids AS "notifyUserIds",supervisor_user_ids AS "supervisorUserIds",source_org_unit_id AS "sourceOrgUnitId",source_org_unit_name AS "sourceOrgUnitName",expires_at AS "expiresAt",created_at AS "createdAt" FROM crm_contact_assignment_requests WHERE request_id=$1',[memberRequest.requestId])).rows[0];
   expect(notification.notifyUserIds).toEqual(expect.arrayContaining([member.id,leader.id]));expect(notification.supervisorUserIds).toEqual([leader.id]);expect(notification).toMatchObject({sourceOrgUnitId:operationsUnit,sourceOrgUnitName:'CP2 Operations'});expect(new Date(notification.expiresAt).getTime()).toBeGreaterThan(new Date(notification.createdAt).getTime());
   expect(await repo.contactDetail(leader.hash,memberContact)).toMatchObject({ok:false,error:{code:'NOT_FOUND'}});
   const accepted=unwrap(await repo.decideContactAssignment(member.hash,'accept',{requestId:memberRequest.requestId,expectedVersion:memberRequest.version,idempotencyKey:randomUUID()}));
   const oversightContact=await contactFixture('Oversight contact');
   expect(await repo.createContactAssignments(superadmin.hash,{targetUserId:member.id,idempotencyKey:randomUUID(),contacts:[oversightContact]})).toMatchObject({ok:false,error:{code:'FORBIDDEN'}});
   expect(await repo.processExpiredAssignments!(superadmin.hash,{limit:200})).toMatchObject({ok:false,error:{code:'FORBIDDEN'}});
   expect(unwrap(await repo.contactDetail(superadmin.hash,oversightContact))).toMatchObject({canEdit:true,canFollowup:true});
    expect(unwrap(await repo.contactDetail(member.hash,memberContact)).contact.ownerUserId).toBe(member.id);
    const memberPrimary=(await client.query('SELECT email FROM contacts WHERE id=$1',[memberContact.contactId])).rows[0].email as string;
    const mailEvent=unwrap(await (repo as unknown as ContactMailRepository).recordContactMailEvent(member.hash,{...memberContact,eventKey:randomUUID(),mailboxKey:'cp2-mailbox',messageKey:'<cp2-analysis>',kind:'replied',direction:'inbound',occurredAt:new Date().toISOString(),subject:'Re: Quotation request',preview:'Please quote urgently',fromEmail:memberPrimary,toEmails:['sales@agency.test'],ccEmails:[]}));
    const analysisKey={contactId:memberContact.contactId,customerId:memberContact.customerId,mailboxKey:'cp2-mailbox',messageKey:'<cp2-analysis>',contentHash:mailEvent.event.contentHash,includeHistory:false,historyLimit:20};
    expect(unwrap(await analysisRepo.current(member.hash,analysisKey))).toMatchObject({access:'normal',canCorrect:true,current:{contactState:'replied'}});
    expect(unwrap(await analysisRepo.current(ops.hash,analysisKey))).toMatchObject({access:'normal',canCorrect:true,current:{contactState:'replied'}});
    expect(unwrap(await analysisRepo.current(leader.hash,analysisKey))).toMatchObject({access:'monitor',canCorrect:false,current:{contactState:'replied'}});
    expect(await analysisRepo.correct(leader.hash,{...analysisKey,idempotencyKey:randomUUID(),expectedCurrentId:mailEvent.analysis.analysisId,classification:'replied',relevance:'customer_business',summary:'supervisor edit',signals:[],requiresAction:false,nextAction:null,priority:'normal',dueHint:null,confidence:1,evidence:[]})).toMatchObject({ok:false,error:{code:'FORBIDDEN'}});
   expect(unwrap(await repo.listContacts(leader.hash,{search:'',limit:50,offset:0})).items.some(row=>row.contactId===memberContact.contactId)).toBe(false);expect(unwrap(await repo.listContactGroups(leader.hash,{dimension:'batch',scope:'all',search:'',limit:24,offset:0})).total).toBe(0);
   const monitored=unwrap(await repo.contactMonitorDetail!(leader.hash,memberContact));expect(monitored.relationship).toBe('direct_leader');expect(monitored.auditId).toEqual(expect.any(String));expect(monitored).not.toHaveProperty('canEdit');
    expect((await client.query('SELECT count(*)::int AS count FROM crm_contact_monitor_audits WHERE actor_id=$1 AND contact_id=$2',[leader.id,memberContact.contactId])).rows[0].count).toBe(2);
   const monitorServer=createServer(createContactAssignmentHandler(createContactAssignmentService(repo,{...tokenAdapter,hash:()=>leader.hash})));await new Promise<void>(resolve=>monitorServer.listen(0,'127.0.0.1',resolve));try{const response=await (await fetch(`http://127.0.0.1:${(monitorServer.address() as {port:number}).port}/api/crm/contact-monitor/${memberContact.contactId}?customerId=${memberContact.customerId}`,{headers:{Authorization:`Bearer ${'a'.repeat(43)}`}})).json();expect(response).toMatchObject({ok:true,data:{relationship:'direct_leader',contact:{contactId:memberContact.contactId}}});}finally{monitorServer.closeAllConnections();await new Promise<void>(resolve=>monitorServer.close(()=>resolve()));}
   expect(await repo.contactUpdate(leader.hash,{...memberContact,expectedVersion:accepted.version,idempotencyKey:randomUUID(),fields:{phone:'forbidden'}})).toMatchObject({ok:false,error:{code:'NOT_FOUND'}});
   expect(await repo.contactFollowup(leader.hash,{...memberContact,expectedVersion:accepted.version,idempotencyKey:randomUUID(),note:'forbidden',method:'note'})).toMatchObject({ok:false,error:{code:'NOT_FOUND'}});

   const transferOne=unwrap(await repo.transferContactAssignment!(member.hash,{requestId:memberRequest.requestId,targetUserId:peer.id,expectedVersion:accepted.version,idempotencyKey:randomUUID()}));
   expect((await client.query('SELECT status,previous_target_user_id AS "previousTargetUserId",target_user_id AS "targetUserId" FROM crm_contact_assignment_requests WHERE request_id=$1',[memberRequest.requestId])).rows[0]).toMatchObject({status:'pending_transfer',previousTargetUserId:member.id,targetUserId:peer.id});
   expect((await client.query('SELECT owner_user_id FROM crm_contact_ownership WHERE contact_id=$1 AND ended_at IS NULL',[memberContact.contactId])).rows[0].owner_user_id).toBe(member.id);
   const notifications=new PostgresNotificationRepository(facade,{write:()=>{}});unwrap(await notifications.migrate());unwrap(await notifications.dispatch());
   const transferNotice=unwrap(await notifications.feed(leader.hash,{deviceId:'cp2-supervisor',after:'0',limit:100,latest:true})).items.find(row=>row.requestId===memberRequest.requestId&&row.eventType==='crm.contact.assignment.transfer_requested');
   expect(transferNotice).toMatchObject({canOpen:true,contactOpenMode:'monitor',assignmentStatus:'pending_transfer',contactId:memberContact.contactId,customerId:memberContact.customerId});if(!transferNotice)throw Error('missing transfer notice');expect((await notifications.read(leader.hash,transferNotice.id)).ok).toBe(true);
   expect(await repo.contactDetail(leader.hash,memberContact)).toMatchObject({ok:false,error:{code:'NOT_FOUND'}});expect(unwrap(await repo.contactMonitorDetail!(leader.hash,memberContact)).contact.contactId).toBe(memberContact.contactId);
   const locked=unwrap(await repo.contactDetail(member.hash,memberContact));expect(locked).toMatchObject({canEdit:false,canFollowup:false,canSendMail:false,canDelete:false});
   expect(await repo.contactUpdate(member.hash,{...memberContact,expectedVersion:locked.contact.contactVersion!,idempotencyKey:randomUUID(),fields:{phone:'blocked'}})).toMatchObject({ok:false,error:{code:'FORBIDDEN'}});
   expect(await repo.contactFollowup(member.hash,{...memberContact,expectedVersion:locked.contact.contactVersion!,idempotencyKey:randomUUID(),note:'blocked',method:'note'})).toMatchObject({ok:false,error:{code:'FORBIDDEN'}});
   expect(await repo.authorizeSend(member.hash,{sendKey:randomUUID(),fromEmail:'member@example.invalid',subject:'blocked',recipients:[{...memberContact,email:locked.contact.email!}]})).toMatchObject({ok:false,error:{code:'NOT_FOUND'}});
   expect(await repo.deleteContacts(member.hash,{contacts:[{...memberContact,expectedVersion:locked.contact.contactVersion!}],idempotencyKey:randomUUID()})).toMatchObject({ok:false,error:{code:'FORBIDDEN'}});
   expect(await repo.decideContactAssignment(member.hash,'reject',{requestId:memberRequest.requestId,expectedVersion:transferOne.version,idempotencyKey:randomUUID()})).toMatchObject({ok:false,error:{code:'NOT_FOUND'}});
   expect(await repo.decideContactAssignment(peer.hash,'cancel',{requestId:memberRequest.requestId,expectedVersion:transferOne.version,idempotencyKey:randomUUID()})).toMatchObject({ok:false,error:{code:'NOT_FOUND'}});
   const rejectedTransfer=unwrap(await repo.decideContactAssignment(peer.hash,'reject',{requestId:memberRequest.requestId,expectedVersion:transferOne.version,idempotencyKey:randomUUID()}));expect(rejectedTransfer.targetUserId).toBe(member.id);expect((await client.query('SELECT status,target_user_id FROM crm_contact_assignment_requests WHERE request_id=$1',[memberRequest.requestId])).rows[0]).toEqual({status:'accepted',target_user_id:member.id});

   const transferTwo=unwrap(await repo.transferContactAssignment!(member.hash,{requestId:memberRequest.requestId,targetUserId:peer.id,expectedVersion:rejectedTransfer.version,idempotencyKey:randomUUID()}));await client.query("UPDATE crm_contact_assignment_requests SET expires_at=now()-interval '1 second' WHERE request_id=$1",[memberRequest.requestId]);
   expect(unwrap(await repo.processExpiredAssignments!(ops.hash,{limit:200})).expired.map(row=>row.requestId)).not.toContain(memberRequest.requestId);expect((await client.query('SELECT status,target_user_id FROM crm_contact_assignment_requests WHERE request_id=$1',[memberRequest.requestId])).rows[0]).toEqual({status:'accepted',target_user_id:member.id});
   expect(await repo.decideContactAssignment(peer.hash,'accept',{requestId:memberRequest.requestId,expectedVersion:transferTwo.version,idempotencyKey:randomUUID()})).toMatchObject({ok:false,error:{code:'NOT_FOUND'}});

   const afterExpiryVersion=(await client.query('SELECT version FROM crm_contact_assignment_requests WHERE request_id=$1',[memberRequest.requestId])).rows[0].version;
   const transferThree=unwrap(await repo.transferContactAssignment!(member.hash,{requestId:memberRequest.requestId,targetUserId:peer.id,expectedVersion:afterExpiryVersion,idempotencyKey:randomUUID()}));const restored=unwrap(await repo.decideContactAssignment(member.hash,'cancel',{requestId:memberRequest.requestId,expectedVersion:transferThree.version,idempotencyKey:randomUUID()}));expect(restored.targetUserId).toBe(member.id);
   const transferFour=unwrap(await repo.transferContactAssignment!(member.hash,{requestId:memberRequest.requestId,targetUserId:peer.id,expectedVersion:restored.version,idempotencyKey:randomUUID()}));unwrap(await repo.decideContactAssignment(peer.hash,'accept',{requestId:memberRequest.requestId,expectedVersion:transferFour.version,idempotencyKey:randomUUID()}));
   expect((await client.query('SELECT owner_user_id FROM crm_contact_ownership WHERE contact_id=$1 AND ended_at IS NULL',[memberContact.contactId])).rows[0].owner_user_id).toBe(peer.id);expect((await client.query('SELECT count(*)::int AS count FROM crm_contact_ownership WHERE contact_id=$1',[memberContact.contactId])).rows[0].count).toBe(2);expect(await repo.contactDetail(member.hash,memberContact)).toMatchObject({ok:false,error:{code:'NOT_FOUND'}});expect(unwrap(await repo.contactDetail(peer.hash,memberContact)).contact.ownerUserId).toBe(peer.id);

   const leaderContact=await contactFixture('Leader contact'),leaderRequest=unwrap(await repo.createContactAssignments(ops.hash,{targetUserId:leader.id,idempotencyKey:randomUUID(),contacts:[leaderContact]})).items[0]!;
   const leaderNotice=(await client.query('SELECT notify_user_ids AS "notifyUserIds",supervisor_user_ids AS "supervisorUserIds" FROM crm_contact_assignment_requests WHERE request_id=$1',[leaderRequest.requestId])).rows[0];expect(leaderNotice.notifyUserIds).toEqual([leader.id]);expect(leaderNotice.supervisorUserIds).toEqual([]);

   const expiringContact=await contactFixture('Expiring contact'),expiring=unwrap(await repo.createContactAssignments(ops.hash,{targetUserId:member.id,idempotencyKey:randomUUID(),contacts:[expiringContact]})).items[0]!;await client.query("UPDATE crm_contact_assignment_requests SET expires_at=now()-interval '1 second' WHERE request_id=$1",[expiring.requestId]);
   expect(await repo.decideContactAssignment(member.hash,'accept',{requestId:expiring.requestId,expectedVersion:expiring.version,idempotencyKey:randomUUID()})).toMatchObject({ok:false,error:{code:'CONFLICT'}});
   expect(unwrap(await processExpiredAssignmentsSystemIn(client,200)).expiredIds).toContain(expiring.requestId);
   unwrap(await notifications.dispatch());const expiredNotice=unwrap(await notifications.feed(leader.hash,{deviceId:'cp2-supervisor',after:'0',limit:100,latest:true})).items.find(row=>row.requestId===expiring.requestId&&row.eventType==='crm.contact.assignment.expired');expect(expiredNotice).toMatchObject({canOpen:true,contactOpenMode:'monitor',assignmentStatus:'expired',contactId:expiringContact.contactId,customerId:expiringContact.customerId});
   const expiringHttpContact=await contactFixture('Expiring http contact'),expiringHttp=unwrap(await repo.createContactAssignments(ops.hash,{targetUserId:member.id,idempotencyKey:randomUUID(),contacts:[expiringHttpContact]})).items[0]!;await client.query("UPDATE crm_contact_assignment_requests SET expires_at=now()-interval '1 second' WHERE request_id=$1",[expiringHttp.requestId]);
   const expireServer=createServer(createContactAssignmentHandler(createContactAssignmentService(repo,{...tokenAdapter,hash:()=>ops.hash})));await new Promise<void>(resolve=>expireServer.listen(0,'127.0.0.1',resolve));try{const endpoint=`http://127.0.0.1:${(expireServer.address() as {port:number}).port}/api/crm/contact-assignments/expire`,headers={Authorization:`Bearer ${'a'.repeat(43)}`,'Content-Type':'application/json'},first=await (await fetch(endpoint,{method:'POST',headers,body:JSON.stringify({limit:200})})).json(),second=await (await fetch(endpoint,{method:'POST',headers,body:JSON.stringify({limit:200})})).json();expect(first).toMatchObject({ok:true});expect(first.data.expired.map((row:{requestId:string})=>row.requestId)).toContain(expiringHttp.requestId);expect(second).toMatchObject({ok:true,data:{expired:[]}});}finally{expireServer.closeAllConnections();await new Promise<void>(resolve=>expireServer.close(()=>resolve()));}expect((await client.query('SELECT count(*)::int AS count FROM crm_contact_ownership WHERE contact_id=$1',[expiringContact.contactId])).rows[0].count).toBe(0);

   const retired=createServer(createContactAssignmentHandler(createContactAssignmentService(repo,tokenAdapter)));await new Promise<void>(resolve=>retired.listen(0,'127.0.0.1',resolve));
   try{const endpoint=`http://127.0.0.1:${(retired.address() as {port:number}).port}/api/crm/leads/${randomUUID()}/assign`;const result=await (await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({customerId:randomUUID(),expectedVersion:1,idempotencyKey:randomUUID(),salesUserId:member.id,notifyUserIds:[peer.id]})})).json();expect(result).toMatchObject({ok:false,error:{code:'CONFLICT'}});}finally{retired.closeAllConnections();await new Promise<void>(resolve=>retired.close(()=>resolve()));}
  }finally{await client.query('ROLLBACK');expect((await client.query('SELECT count(*)::int AS count FROM public.identity_outbox')).rows[0].count).toBe(before);client.release();await pool.end();}
 },30000);

 it('uses independent connections so parallel assignment and accept-vs-expire have one winner',async()=>{
  const pool=new Pool(readTestDatabaseConfig());
  const userIds:string[]=[];let customerId:string|undefined,companyId:number|undefined,operationsUnit:string|undefined,salesTeam:string|undefined;
  try{
   const repo=new PostgresLeadRepository(pool,{write:()=>{}});unwrap(await repo.migrate());unwrap(await new PostgresTeamRepository(pool,{write:()=>{}}).migrate());unwrap(await repo.migrateAssignmentState());unwrap(await repo.migrateAssignmentState());
   const actors:Array<{id:string;hash:string}>=[];
   for(const role of ['operations','operations','sales'] as const){const id=randomUUID(),token=randomBytes(32).toString('base64url');userIds.push(id);await pool.query('INSERT INTO public.identity_users(user_id,display_name) VALUES($1,$2)',[id,`cp2-race-${id}`]);await pool.query("INSERT INTO public.identity_product_grants(user_id,product_id,role) VALUES($1,'crm',$2)",[id,role]);await pool.query("INSERT INTO public.identity_product_access(user_id,product_id,scope,capabilities) VALUES($1,'crm',$2,$3)",[id,role==='operations'?'shared':'own',JSON.stringify(capabilitiesFor([role]))]);await pool.query("INSERT INTO public.identity_sessions(token_hash,user_id,security_revision,expires_at,client) VALUES($1,$2,1,now()+interval '1 hour','api')",[tokenAdapter.hash(token),id]);actors.push({id,hash:tokenAdapter.hash(token)});}
   const [opsOne,opsTwo,target]=actors as [typeof actors[number],typeof actors[number],typeof actors[number]],root=(await pool.query("SELECT unit_id FROM crm_org_units WHERE kind='company'")).rows[0].unit_id;
   operationsUnit=(await pool.query("INSERT INTO crm_org_units(kind,parent_unit_id,name,created_by) VALUES('operations_group',$1,$2,$3) RETURNING unit_id",[root,`Race ops ${randomUUID()}`,opsOne.id])).rows[0].unit_id;
   salesTeam=(await pool.query("INSERT INTO crm_org_units(kind,parent_unit_id,name,created_by) VALUES('sales_team',$1,$2,$3) RETURNING unit_id",[operationsUnit,`Race sales ${randomUUID()}`,opsOne.id])).rows[0].unit_id;
   await pool.query("INSERT INTO crm_org_assignments(user_id,unit_id,role,is_primary) VALUES($1,$2,'leader',true)",[opsOne.id,operationsUnit]);await pool.query("INSERT INTO crm_org_assignments(user_id,unit_id,role) VALUES($1,$2,'member')",[target.id,salesTeam]);
   companyId=(await pool.query('INSERT INTO companies(name) VALUES($1) RETURNING id',[`race-company-${randomUUID()}`])).rows[0].id;customerId=randomUUID();await pool.query("INSERT INTO crm_customers(customer_id,company_id,source,customer_key,source_detail,created_by,origin) VALUES($1,$2,'race',$1::uuid::text,'race',$3,'operations')",[customerId,companyId,opsOne.id]);const contactId=(await pool.query('INSERT INTO contacts(email,first_name,company_id) VALUES($1,$2,$3) RETURNING id',[`${randomUUID()}@example.invalid`,'Race contact',companyId])).rows[0].id;await pool.query('INSERT INTO crm_customer_contacts(customer_id,contact_id) VALUES($1,$2)',[customerId,contactId]);
   const ref={contactId:contactId as number,customerId,expectedVersion:1};
   const race=await Promise.all([opsOne,opsTwo].map(actor=>repo.createContactAssignments(actor.hash,{targetUserId:target.id,idempotencyKey:randomUUID(),contacts:[ref]})));
   expect(race.filter(result=>result.ok)).toHaveLength(1);expect(race.filter(result=>!result.ok)).toHaveLength(1);expect(race.find(result=>!result.ok)).toMatchObject({error:{code:'CONFLICT'}});
   const winner=race.find(result=>result.ok);if(!winner?.ok)throw Error('missing race winner');const request=winner.data.items[0]!;await pool.query("UPDATE crm_contact_assignment_requests SET expires_at=now()-interval '1 second' WHERE request_id=$1",[request.requestId]);
   const [acceptResult,expireResult]=await Promise.all([repo.decideContactAssignment(target.hash,'accept',{requestId:request.requestId,expectedVersion:request.version,idempotencyKey:randomUUID()}),repo.processExpiredAssignments(opsOne.hash,{limit:200})]);
   expect(expireResult.ok).toBe(true);expect(acceptResult).toMatchObject({ok:false,error:{code:'CONFLICT'}});
   const final=(await pool.query('SELECT status FROM crm_contact_assignment_requests WHERE request_id=$1',[request.requestId])).rows[0].status,ownership=(await pool.query('SELECT owner_user_id FROM crm_contact_ownership WHERE contact_id=$1 AND ended_at IS NULL',[contactId])).rows;
   expect(final).toBe('expired');expect(ownership).toHaveLength(0);
   const scheduled=unwrap(await repo.createContactAssignments(opsOne.hash,{targetUserId:target.id,idempotencyKey:randomUUID(),contacts:[ref]})).items[0]!;await pool.query("UPDATE crm_contact_assignment_requests SET expires_at=now()-interval '1 second' WHERE request_id=$1",[scheduled.requestId]);
   const scheduler=startAssignmentExpiryScheduler(pool,{write:()=>{}});try{let status='pending';for(let attempt=0;attempt<30&&status==='pending';attempt++){await new Promise(resolve=>setTimeout(resolve,50));status=(await pool.query('SELECT status FROM crm_contact_assignment_requests WHERE request_id=$1',[scheduled.requestId])).rows[0].status;}expect(status).toBe('expired');}finally{await scheduler.stop();}
  }finally{
   if(customerId){await pool.query('DELETE FROM crm_contact_monitor_audits WHERE customer_id=$1',[customerId]);await pool.query('DELETE FROM crm_contact_changes WHERE customer_id=$1',[customerId]);await pool.query('DELETE FROM public.identity_outbox WHERE customer_id=$1',[customerId]);await pool.query('DELETE FROM crm_contact_ownership WHERE customer_id=$1',[customerId]);await pool.query('DELETE FROM crm_contact_assignment_group_members WHERE request_id IN(SELECT request_id FROM crm_contact_assignment_requests WHERE customer_id=$1)',[customerId]);await pool.query('DELETE FROM crm_contact_assignment_requests WHERE customer_id=$1',[customerId]);await pool.query('DELETE FROM crm_customer_contacts WHERE customer_id=$1',[customerId]);await pool.query('DELETE FROM crm_customers WHERE customer_id=$1',[customerId]);}
   if(companyId!==undefined){await pool.query('DELETE FROM contacts WHERE company_id=$1',[companyId]);await pool.query('DELETE FROM companies WHERE id=$1',[companyId]);}if(salesTeam)await pool.query('DELETE FROM crm_org_units WHERE unit_id=$1',[salesTeam]);if(operationsUnit)await pool.query('DELETE FROM crm_org_units WHERE unit_id=$1',[operationsUnit]);
   if(userIds.length){await pool.query('DELETE FROM crm_lead_idempotency WHERE actor_id=ANY($1::uuid[])',[userIds]);await pool.query('DELETE FROM public.identity_sessions WHERE user_id=ANY($1::uuid[])',[userIds]);await pool.query('DELETE FROM public.identity_product_access WHERE user_id=ANY($1::uuid[])',[userIds]);await pool.query('DELETE FROM public.identity_product_grants WHERE user_id=ANY($1::uuid[])',[userIds]);await pool.query('DELETE FROM public.identity_users WHERE user_id=ANY($1::uuid[])',[userIds]);}
   await pool.end();
  }
 },30000);
});

