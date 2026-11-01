import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readTestDatabaseConfig } from '../../server/adapters/postgres/config';
import { PostgresLeadRepository } from '../../server/adapters/postgres/lead-repository';
import { PostgresNotificationRepository } from '../../server/adapters/postgres/notification-repository';
import { capabilitiesFor } from '../../server/core/admin';
import { tokenAdapter } from '../../server/adapters/password';
import { CONTACT_MAIL_ROUTE, type ContactMailEventInput, type ContactMailRepository } from '../../server/core/contact-mail';
import { createContactMailService } from '../../server/services/contact-mail';
import { createContactMailHandler } from '../../server/transport/contact-mail-http';
import type { Result } from '../../server/core/crm';
import { PostgresContactMailAnalysisRepository } from '../../server/adapters/postgres/contact-mail-analysis-repository';
import { createContactMailAnalysisService } from '../../server/services/contact-mail-analysis';
import { createContactMailAnalysisHandler } from '../../server/transport/contact-mail-analysis-http';
import { CONTACT_MAIL_ANALYSIS_ROUTES } from '../../server/core/mail-analysis';
function unwrap<T>(result: Result<T>): T { if (!result.ok) throw Error(`${result.error.code}: ${result.error.message}`); return result.data; }
describe.runIf(process.env.PROSPECTOR_PG_INTEGRATION === '1')('contact mail events outer rollback PostgreSQL', () => {
  it('isolates selected contacts, deduplicates, keeps monotonic touch and commits fact/activity/outbox together', async () => {
    const pool = new Pool(readTestDatabaseConfig()), client = await pool.connect();
    const counts = async () => (await client.query('SELECT (SELECT count(*) FROM public.identity_users) AS users,(SELECT count(*) FROM contacts) AS contacts,(SELECT count(*) FROM crm_shared_activities) AS activities,(SELECT count(*) FROM public.identity_outbox) AS outbox,(SELECT count(*) FROM crm_schema_migrations) AS migrations')).rows[0];
    const before = await counts(); await client.query('BEGIN');
    try {
      let lease = Promise.resolve();
      const facade = { options: pool.options, connect: async () => {
        const old = lease; let release!: () => void; lease = new Promise<void>(resolve => { release = resolve; }); await old;
        return { query: (sql: string, args?: unknown[]) => client.query(sql === 'BEGIN' ? 'SAVEPOINT mail_test' : sql === 'COMMIT' ? 'RELEASE SAVEPOINT mail_test' : sql === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT mail_test' : sql, args), release };
      } } as unknown as Pool;
      const repo = new PostgresLeadRepository(facade, { write: () => {} }), mail = repo as unknown as ContactMailRepository;
      expect(typeof mail.recordContactMailEvent).toBe('function');
      unwrap(await repo.migrate());
      unwrap(await repo.migrateAssignmentState());
      unwrap(await repo.migrateLeadMatch());
      const analysisRepo=new PostgresContactMailAnalysisRepository(facade,{write:()=>{}});
      unwrap(await analysisRepo.migrate());
      unwrap(await analysisRepo.migrate());
      const actors: Array<{ id: string; hash: string; token: string }> = [];
      for (const role of ['operations', 'sales', 'sales'] as const) {
        const id = randomUUID(), token = randomBytes(32).toString('base64url');
        await client.query('INSERT INTO public.identity_users(user_id,display_name) VALUES($1,$2)', [id, `rollback-${id}`]);
        await client.query("INSERT INTO public.identity_product_grants(user_id,product_id,role) VALUES($1,'crm',$2)", [id, role]);
        await client.query("INSERT INTO public.identity_product_access(user_id,product_id,scope,capabilities) VALUES($1,'crm',$2,$3)", [id, role === 'operations' ? 'shared' : 'own', JSON.stringify(capabilitiesFor([role]))]);
        await client.query("INSERT INTO public.identity_sessions(token_hash,user_id,security_revision,expires_at,client) VALUES($1,$2,1,now()+interval '1 hour','api')", [tokenAdapter.hash(token), id]);
        actors.push({ id, hash: tokenAdapter.hash(token), token });
      }
      const [ops, sales, other] = actors as [typeof actors[number], typeof actors[number], typeof actors[number]];
      const company = (await client.query("INSERT INTO companies(name) VALUES('mail-rollback-fixture') RETURNING id")).rows[0].id, customerId = randomUUID();
      await client.query("INSERT INTO crm_customers(customer_id,company_id,source,customer_key,source_detail,created_by,origin) VALUES($1,$2,'rollback',$1::uuid::text,'fixture',$3,'operations')", [customerId, company, ops.id]);
      const contacts: number[] = [];
      for (const name of ['Selected', 'Sibling']) {
        const contactId = (await client.query('INSERT INTO contacts(email,first_name,company_id) VALUES($1,$2,$3) RETURNING id', [`${randomUUID()}@example.invalid`, name, company])).rows[0].id;
        contacts.push(contactId); await client.query('INSERT INTO crm_customer_contacts(customer_id,contact_id) VALUES($1,$2)', [customerId, contactId]);
      }
      const contactId = contacts[0]!, sibling = contacts[1]!, sender = 'sales@agency.test';
      const primary = (await client.query('SELECT email FROM contacts WHERE id=$1', [contactId])).rows[0].email;
      const event: ContactMailEventInput = { contactId, customerId, eventKey: randomUUID(), mailboxKey: 'opaque-account', messageKey: '<fixture-message>', kind: 'sent', direction: 'outbound', occurredAt: '2020-01-02T00:00:00.000Z', subject: 'Fixture subject', preview: 'Fixture preview', fromEmail: sender, toEmails: [primary], ccEmails: [] };
      expect(await mail.recordContactMailEvent(sales.hash, event)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
      // The uploading administrator retains authority after acceptance; unrelated users never gain it.
      const opsEvent = unwrap(await mail.recordContactMailEvent(ops.hash, { ...event, contactId: sibling, eventKey: randomUUID(), toEmails: [] }));
      expect(opsEvent.contact.touchStatus).toBe('uncontacted');
      const request = unwrap(await repo.createContactAssignments(ops.hash, { contacts: [{ contactId, customerId, expectedVersion: 1 }], targetUserId: sales.id, idempotencyKey: randomUUID() })).items[0]!;
      unwrap(await repo.decideContactAssignment(sales.hash, 'accept', { requestId: request.requestId, expectedVersion: 1, idempotencyKey: randomUUID() }));
      expect(unwrap(await mail.recordContactMailEvent(ops.hash, {...event,eventKey:randomUUID()})).event.actorId).toBe(ops.id);
      expect(await mail.recordContactMailEvent(other.hash, event)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
      expect(await mail.recordContactMailEvent(sales.hash, { ...event, contactId: sibling })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
      const sent = unwrap(await mail.recordContactMailEvent(sales.hash, event));
      expect(sent).toMatchObject({ duplicate: false, contact: { contactId, touchStatus: 'contacted', lastFollowupAt: event.occurredAt }, event: { actorId: sales.id, subject: event.subject, preview: event.preview } });
      expect(sent.analysis).toMatchObject({ source:'rule', relevance:'customer_business', contactState:'contacted', requiresAction:false });
      expect(sent.event.contentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(sent.event.activityId).not.toBeNull();
      const duplicate = unwrap(await mail.recordContactMailEvent(sales.hash, event));
      expect(duplicate).toMatchObject({ duplicate: true, eventId: sent.eventId }); expect(duplicate.contact.contactVersion).toBe(sent.contact.contactVersion);
      expect(await mail.recordContactMailEvent(sales.hash, { ...event, preview: 'different payload' })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      const replyInput = { ...event, eventKey: randomUUID(), messageKey: '<reply>', kind: 'replied' as const, direction: 'inbound' as const, fromEmail: primary, toEmails: [sender], occurredAt: '2020-02-02T00:00:00.000Z', subject:'Re: Quotation request', preview:'Please quote two 40HQ containers' };
      const reply = unwrap(await mail.recordContactMailEvent(sales.hash, replyInput));
      expect(reply.contact.touchStatus).toBe('replied');
      expect(reply.analysis).toMatchObject({ source:'rule', contactState:'replied', signals:[{code:'quote_request'}], requiresAction:true });
      const replyKey={contactId,customerId,mailboxKey:replyInput.mailboxKey,messageKey:replyInput.messageKey,contentHash:reply.event.contentHash};
      const ai=unwrap(await analysisRepo.submitAI(sales.hash,{...replyKey,inputSequence:Date.parse(replyInput.occurredAt)+10,idempotencyKey:'ai-quote-1',result:{classification:'replied',relevance:'customer_business',summary:'客户要求两个40HQ报价',signals:[{code:'quote_request',label:'报价请求',confidence:.94,evidence:'quote two'}],actionability:{requiresAction:true,nextAction:'回复客户询价',priority:'important',dueHint:'24 小时内'},confidence:.94,evidence:['quote two'],analyzerVersion:'ai-test-v1'}}));
      expect(ai).toMatchObject({source:'ai',isCurrent:true,contactState:'replied',summary:'客户要求两个40HQ报价'});
      expect(unwrap(await analysisRepo.submitAI(sales.hash,{...replyKey,inputSequence:Date.parse(replyInput.occurredAt)+10,idempotencyKey:'ai-quote-1',result:{classification:'replied',relevance:'customer_business',summary:'客户要求两个40HQ报价',signals:[{code:'quote_request',label:'报价请求',confidence:.94,evidence:'quote two'}],actionability:{requiresAction:true,nextAction:'回复客户询价',priority:'important',dueHint:'24 小时内'},confidence:.94,evidence:['quote two'],analyzerVersion:'ai-test-v1'}})).analysisId).toBe(ai.analysisId);
      const lateAI=unwrap(await analysisRepo.submitAI(sales.hash,{...replyKey,inputSequence:1,idempotencyKey:'ai-quote-late',result:{classification:'replied',relevance:'customer_business',summary:'过期AI',signals:[{code:'no_action',label:'无需行动',confidence:.9,evidence:'late'}],actionability:{requiresAction:false,nextAction:null,priority:'normal',dueHint:null},confidence:.9,evidence:['late'],analyzerVersion:'ai-test-v2'}}));
      expect(lateAI.isCurrent).toBe(false);
      const human=unwrap(await analysisRepo.correct(sales.hash,{...replyKey,idempotencyKey:'human-quote-1',expectedCurrentId:ai.analysisId,classification:'replied',relevance:'customer_business',summary:'人工确认：客户在等报价',signals:[{code:'quote_request',label:'报价请求',confidence:1,evidence:'人工确认'}],requiresAction:true,nextAction:'今天回复报价',priority:'urgent',dueHint:'今日',confidence:1,evidence:['人工确认']}));
      expect(human).toMatchObject({source:'human',humanLocked:true,isCurrent:true,nextAction:'今天回复报价'});
      const afterHuman=unwrap(await analysisRepo.submitAI(sales.hash,{...replyKey,inputSequence:Number.MAX_SAFE_INTEGER,idempotencyKey:'ai-after-human',result:{classification:'replied',relevance:'customer_business',summary:'AI后来结论',signals:[],actionability:{requiresAction:false,nextAction:null,priority:'normal',dueHint:null},confidence:.8,evidence:[],analyzerVersion:'ai-test-v3'}}));
      expect(afterHuman.isCurrent).toBe(false);
      const history=unwrap(await analysisRepo.current(sales.hash,{...replyKey,includeHistory:true,historyLimit:20}));
      expect(history).toMatchObject({current:{analysisId:human.analysisId,source:'human'},canCorrect:true,access:'normal',taskSuggestion:{actionCode:'quote_request',nextAction:'今天回复报价'}});
      expect(history.history.map(row=>row.analysisId)).toEqual(expect.arrayContaining([ai.analysisId,lateAI.analysisId,afterHuman.analysisId]));
      expect(unwrap(await analysisRepo.current(sales.hash,{...replyKey,includeHistory:false,historyLimit:20}))).toMatchObject({current:{analysisId:human.analysisId,source:'human'},history:[]});
      expect((await client.query("SELECT count(*)::int AS n FROM crm_contact_mail_task_suggestions WHERE actor_id=$1 AND contact_id=$2 AND action_code='quote_request'",[sales.id,contactId])).rows[0].n).toBe(1);
      expect(await analysisRepo.current(other.hash,{...replyKey,includeHistory:false,historyLimit:20})).toMatchObject({ok:false});
      expect((await client.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='prospector' AND table_name='crm_contact_mail_analyses' AND column_name IN ('body','raw_body','attachments')")).rows[0].n).toBe(0);
      const older = unwrap(await mail.recordContactMailEvent(sales.hash, { ...event, eventKey: randomUUID(), occurredAt: '2019-01-02T00:00:00.000Z' }));
      expect(older.contact).toMatchObject({ touchStatus: 'replied', lastFollowupAt: replyInput.occurredAt });
      for (const kind of ['cc', 'received'] as const) {
        const harmless = unwrap(await mail.recordContactMailEvent(sales.hash, { ...replyInput,kind,eventKey: randomUUID(),messageKey:`<${kind}>`,occurredAt:'2022-01-02T00:00:00.000Z',...(kind==='received'?{subject:'FYI only',preview:'Noted, thanks'}:{}) }));
        expect(harmless.contact).toMatchObject({ touchStatus: 'replied', lastFollowupAt: replyInput.occurredAt }); expect(harmless.event.activityId).toBeNull();
        expect(harmless.analysis).toMatchObject({contactState:null,requiresAction:false});
      }
      for (const [kind, touchStatus] of [['autoreply', 'autoreply'], ['bounced', 'bounced']] as const) {
        const outcome = unwrap(await mail.recordContactMailEvent(sales.hash, { ...replyInput, kind, eventKey: randomUUID(), messageKey: `<${kind}>`, occurredAt: '2022-01-03T00:00:00.000Z' }));
        expect(outcome.contact.touchStatus).toBe(touchStatus); expect(outcome.event.activityId).not.toBeNull();expect(outcome.analysis.contactState).toBe(touchStatus);
      }
      const falseReply = unwrap(await mail.recordContactMailEvent(sales.hash, { ...replyInput, fromEmail: 'stranger@example.invalid', eventKey: randomUUID(), occurredAt: '2023-01-02T00:00:00.000Z' }));
      expect(falseReply.contact.touchStatus).toBe('bounced'); expect(falseReply.event.activityId).toBeNull();expect(falseReply.analysis).toMatchObject({contactState:null,requiresAction:false});
      const ccSent = unwrap(await mail.recordContactMailEvent(sales.hash, { ...event, toEmails: ['someone@example.invalid'], ccEmails: [primary], eventKey: randomUUID(), occurredAt: '2023-01-02T00:00:00.000Z' }));
      expect(ccSent.event.activityId).toBeNull();
      const detail = unwrap(await repo.contactDetail(sales.hash, { contactId, customerId }));
      expect(detail).toMatchObject({ mailAvailable: true }); expect(detail.mailEvents[0]!.occurredAt).toBe('2023-01-02T00:00:00.000Z');
      expect(detail.mailEvents).toHaveLength(10); expect(detail.activities).toHaveLength(6);
      expect(unwrap(await repo.contactDetail(ops.hash, { contactId: sibling, customerId })).mailEvents).toHaveLength(1);
      const manual = unwrap(await repo.contactFollowup(sales.hash, { contactId, customerId, expectedVersion: detail.contact.contactVersion!, idempotencyKey: randomUUID(), method: 'phone', note: 'manual call stays visible', contactStatus: 'contacted', occurredAt: '2024-06-01T00:00:00.000Z' }));
      expect(manual.contact.status).toBe('reached');
      const backfill = unwrap(await mail.recordContactMailEvent(sales.hash, { ...replyInput, eventKey: randomUUID(), occurredAt: '2024-01-01T00:00:00.000Z' }));
      expect(backfill.contact).toMatchObject({ touchStatus: 'contacted', lastFollowupAt: '2024-06-01T00:00:00.000Z', lastFollowupNote: 'manual call stays visible' });
      expect(unwrap(await repo.contactDetail(sales.hash, { contactId, customerId })).activities.some(item => item.note === 'manual call stays visible')).toBe(true);
      expect(await repo.contactFollowup(sales.hash, { contactId, customerId, expectedVersion: manual.contact.contactVersion!, idempotencyKey: randomUUID(), method: 'phone', note: 'stale manual form' })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      const annotation = unwrap(await repo.contactFollowup(ops.hash, { contactId: sibling, customerId, expectedVersion: opsEvent.contact.contactVersion!, idempotencyKey: randomUUID(), method: 'note', note: 'stage is classification only', stage: 'quoting', occurredAt: '2024-01-01T00:00:00.000Z' }));
      expect(annotation.contact).toMatchObject({ tags: [], relationshipStage: 'quoting', status: '', touchStatus: 'uncontacted', lastFollowupAt: null });
      expect(await repo.contactFollowup(ops.hash, { contactId: sibling, customerId, expectedVersion: annotation.contact.contactVersion!, idempotencyKey: randomUUID(), method: 'note', note: 'invalid fake touch', contactStatus: 'contacted' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      const siblingReply = unwrap(await repo.contactFollowup(ops.hash, { contactId: sibling, customerId, expectedVersion: annotation.contact.contactVersion!, idempotencyKey: randomUUID(), method: 'phone', note: 'explicit reply and stage', contactStatus: 'replied', stage: 'trial' }));
      expect(siblingReply.contact).toMatchObject({ status: 'replied', touchStatus: 'replied', tags: [], relationshipStage: 'trial' });
      const stageClear = unwrap(await repo.contactFollowup(ops.hash, { contactId: sibling, customerId, expectedVersion: siblingReply.contact.contactVersion!, idempotencyKey: randomUUID(), method: 'note', note: 'clear stage only', stage: 'cold' }));
      expect(stageClear.contact).toMatchObject({ status: 'replied', touchStatus: 'replied', tags: [], relationshipStage: 'cold' });
      const bounced = unwrap(await repo.contactFollowup(ops.hash, { contactId: sibling, customerId, expectedVersion: stageClear.contact.contactVersion!, idempotencyKey: randomUUID(), method: 'email', note: 'mailbox bounced', contactStatus: 'bounced' }));
      expect(bounced.contact).toMatchObject({ status: 'bounced', touchStatus: 'bounced', tags: [] });
      const board = unwrap(await repo.list(ops.hash, { view: 'operations', search: '', limit: 100, offset: 0, followupOnly: true }));
      expect(board.items.some(item => item.customerId === customerId)).toBe(true);
      const touchClear = unwrap(await repo.contactFollowup(ops.hash, { contactId: sibling, customerId, expectedVersion: bounced.contact.contactVersion!, idempotencyKey: randomUUID(), method: 'other', note: 'explicit clear', contactStatus: 'uncontacted' }));
      expect(touchClear.contact).toMatchObject({ status: '', touchStatus: 'uncontacted', tags: [] });
      expect((await client.query("SELECT count(*)::int AS n FROM public.identity_outbox WHERE payload->>'mailEventId'=$1", [sent.eventId])).rows[0].n).toBe(1);
      const outbox = (await client.query("SELECT payload,recipient_user_ids FROM public.identity_outbox WHERE payload->>'mailEventId'=$1", [sent.eventId])).rows[0];
      expect(outbox.recipient_user_ids.sort()).toEqual([ops.id, sales.id].sort());
      expect(JSON.stringify(outbox.payload)).not.toContain(event.preview); expect(JSON.stringify(outbox.payload)).not.toContain(sender);
      const notifications = new PostgresNotificationRepository(facade, { write: () => {} }); unwrap(await notifications.migrate()); unwrap(await notifications.dispatch());
      expect(unwrap(await notifications.feed(ops.hash, { deviceId: 'rollback-mail', after: '0', limit: 100 })).items.some(item => item.eventType === 'crm.contact.followup' && item.contactId === contactId)).toBe(true);
      // Atomicity: a failed notification insert must roll back the new event and its activity/status.
      await client.query("CREATE FUNCTION pg_temp.mail_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture mail outbox'; RETURN NEW; END $$");
      await client.query("CREATE TRIGGER mail_test_outbox_fail BEFORE INSERT ON public.identity_outbox FOR EACH ROW WHEN (NEW.event_type='crm.contact.followup') EXECUTE FUNCTION pg_temp.mail_fail()");
      const failedInput = { ...event, eventKey: randomUUID(), occurredAt: '2024-01-02T00:00:00.000Z' };
      const versionBefore = unwrap(await repo.contactDetail(sales.hash, { contactId, customerId })).contact.contactVersion;
      expect(await mail.recordContactMailEvent(sales.hash, failedInput)).toMatchObject({ ok: false, error: { code: 'DATABASE_ERROR' } });
      expect((await client.query('SELECT count(*)::int AS n FROM crm_contact_mail_events WHERE actor_id=$1 AND event_key=$2', [sales.id, failedInput.eventKey])).rows[0].n).toBe(0);
      expect(unwrap(await repo.contactDetail(sales.hash, { contactId, customerId })).contact).toMatchObject({ contactVersion: versionBefore, touchStatus: 'contacted' });
      expect(await repo.contactFollowup(sales.hash, { contactId, customerId, expectedVersion: versionBefore!, idempotencyKey: randomUUID(), method: 'phone', note: 'atomic explicit status and stage', contactStatus: 'replied', stage: 'cooperating' })).toMatchObject({ ok: false, error: { code: 'DATABASE_ERROR' } });
      expect(unwrap(await repo.contactDetail(sales.hash, { contactId, customerId })).contact).toMatchObject({ contactVersion: versionBefore, touchStatus: 'contacted', status: 'reached', tags: [] });
      await client.query('DROP TRIGGER mail_test_outbox_fail ON public.identity_outbox');
      const service = createContactMailService(mail, tokenAdapter), http = createServer(createContactMailHandler(service));
      await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
      try {
        const base = `http://127.0.0.1:${(http.address() as { port: number }).port}`, headers = { Authorization: `Bearer ${sales.token}`, 'Content-Type': 'application/json' };
        expect((await (await fetch(base + CONTACT_MAIL_ROUTE, { method: 'POST', headers, body: JSON.stringify(event) })).json()).data.duplicate).toBe(true);
        expect((await fetch(base + CONTACT_MAIL_ROUTE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event) })).status).toBe(401);
        expect((await fetch(base + CONTACT_MAIL_ROUTE, { method: 'POST', headers, body: JSON.stringify({ ...event, rawBody: 'private' }) })).status).toBe(400);
      } finally { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); }
      const analysisHttp=createServer(createContactMailAnalysisHandler(createContactMailAnalysisService(analysisRepo,tokenAdapter)));
      await new Promise<void>(resolve=>analysisHttp.listen(0,'127.0.0.1',resolve));
      try{
        const base=`http://127.0.0.1:${(analysisHttp.address() as {port:number}).port}`,headers={Authorization:`Bearer ${sales.token}`,'Content-Type':'application/json'};
        const query=new URLSearchParams({contactId:String(contactId),customerId,mailboxKey:replyInput.mailboxKey,messageKey:replyInput.messageKey,contentHash:reply.event.contentHash,history:'true',limit:'20'});
        expect(await (await fetch(`${base}${CONTACT_MAIL_ANALYSIS_ROUTES.analyses}?${query}`,{headers})).json()).toMatchObject({ok:true,data:{current:{source:'human',analysisId:human.analysisId},access:'normal'}});
        expect((await fetch(`${base}${CONTACT_MAIL_ANALYSIS_ROUTES.analyses}?${query}`,{headers:{}})).status).toBe(401);
        expect(await (await fetch(`${base}${CONTACT_MAIL_ANALYSIS_ROUTES.correct}`,{method:'POST',headers,body:JSON.stringify({...replyKey,idempotencyKey:'human-http',expectedCurrentId:human.analysisId,classification:'replied',relevance:'customer_business',summary:'HTTP人工修正',signals:[],requiresAction:false,nextAction:null,priority:'normal',dueHint:null,confidence:1,evidence:['HTTP']})})).json()).toMatchObject({ok:true,data:{source:'human',isCurrent:true,summary:'HTTP人工修正'}});
        expect((await fetch(`${base}${CONTACT_MAIL_ANALYSIS_ROUTES.correct}`,{method:'POST',headers,body:JSON.stringify({...human,rawBody:'private'})})).status).toBe(400);
      }finally{analysisHttp.closeAllConnections();await new Promise<void>(resolve=>analysisHttp.close(()=>resolve()));}
      await client.query('UPDATE public.identity_sessions SET revoked_at=now() WHERE user_id=$1', [sales.id]);
      expect(await mail.recordContactMailEvent(sales.hash, event)).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
    } finally { await client.query('ROLLBACK'); expect(await counts()).toEqual(before); client.release(); await pool.end(); }
  }, 30000);
});
