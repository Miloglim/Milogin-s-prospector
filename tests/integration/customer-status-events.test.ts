import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { readTestDatabaseConfig } from '../../server/adapters/postgres/config';
import { PostgresLeadRepository } from '../../server/adapters/postgres/lead-repository';
import { PostgresCustomerStatusRepository, recordCustomerStatusEventIn } from '../../server/adapters/postgres/customer-status-repository';
import { PostgresSalesCaseRepository, applyDealWonProposalIn } from '../../server/adapters/postgres/sales-case-repository';
import { capabilitiesFor } from '../../server/core/admin';
import { tokenAdapter } from '../../server/adapters/password';
import type { Result } from '../../server/core/crm';

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
}

describe.runIf(process.env.PROSPECTOR_PG_INTEGRATION === '1')('customer status event ledger PostgreSQL', () => {
  it('records human followups and mail replies in the same transaction', async () => {
    const pool = new Pool(readTestDatabaseConfig()), client = await pool.connect();
    const migration = new PostgresLeadRepository(pool, { write: () => {} });
    unwrap(await migration.migrate());
    const before = (await client.query('SELECT (SELECT count(*) FROM crm_customer_status_events) AS events')).rows[0];
    await client.query('BEGIN');
    try {
      const facade = { options: pool.options, connect: async () => ({ query: (sql: string, args?: unknown[]) => client.query(sql === 'BEGIN' ? 'SAVEPOINT status_test' : sql === 'COMMIT' ? 'RELEASE SAVEPOINT status_test' : sql === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT status_test' : sql, args), release: () => {} }) } as unknown as Pool;
      const repo = new PostgresLeadRepository(facade, { write: () => {} });
      const statusRepo = new PostgresCustomerStatusRepository(facade, { write: () => {} });
      const salesCases = new PostgresSalesCaseRepository(facade, { write: () => {} });
      unwrap(await repo.migrate());
      unwrap(await salesCases.migrate());
      expect((await client.query("SELECT count(*)::int AS n FROM crm_schema_migrations WHERE version='083-customer-status-events'")).rows[0].n).toBe(1);

      const userId = randomUUID(), token = randomBytes(32).toString('base64url'), hash = tokenAdapter.hash(token);
      await client.query('INSERT INTO public.identity_users(user_id,display_name) VALUES($1,$2)', [userId, 'status-event-user']);
      await client.query("INSERT INTO public.identity_product_grants(user_id,product_id,role) VALUES($1,'crm','operations')", [userId]);
      await client.query("INSERT INTO public.identity_product_access(user_id,product_id,scope,capabilities) VALUES($1,'crm','shared',$2)", [userId, JSON.stringify(capabilitiesFor(['operations']))]);
      await client.query("INSERT INTO public.identity_sessions(token_hash,user_id,security_revision,expires_at,client) VALUES($1,$2,1,now()+interval '1 hour','api')", [hash, userId]);

      async function fixture(label: string) {
        const companyId = Number((await client.query('INSERT INTO companies(name) VALUES($1) RETURNING id', [label])).rows[0].id);
        const customerId = String((await client.query("INSERT INTO crm_customers(company_id,source,customer_key,source_detail,state,owner_user_id,created_by,origin,relationship_stage) VALUES($1,'status-events',$2,'synthetic','owned',$3,$3,'operations','cold') RETURNING customer_id", [companyId, randomUUID(), userId])).rows[0].customer_id);
        const email = `${randomUUID()}@example.invalid`;
        const contactId = Number((await client.query('INSERT INTO contacts(email,first_name,company_id,crm_touch_status) VALUES($1,$2,$3,\'uncontacted\') RETURNING id', [email, label, companyId])).rows[0].id);
        await client.query('INSERT INTO crm_customer_contacts(customer_id,contact_id) VALUES($1,$2)', [customerId, contactId]);
        return { customerId, contactId, email };
      }

      const human = await fixture('status-human');
      const humanCommand = { ...human, expectedVersion: 1, idempotencyKey: randomUUID(), note: '客户已询价', method: 'phone' as const, contactStatus: 'replied' as const, stage: 'quoting' as const };
      unwrap(await repo.contactFollowup(hash, humanCommand));
      unwrap(await repo.contactFollowup(hash, humanCommand));
      const humanEvent = (await client.query('SELECT status,previous_status,source,signal,contact_id AS "contactId" FROM crm_customer_status_events WHERE customer_id=$1', [human.customerId])).rows[0];
      expect(humanEvent).toMatchObject({ status: 'quoting', previous_status: 'uncontacted', source: 'human', signal: 'followup' });
      expect(Number(humanEvent.contactId)).toBe(human.contactId);
      expect((await client.query('SELECT count(*)::int AS n FROM crm_customer_status_events WHERE customer_id=$1', [human.customerId])).rows[0].n).toBe(1);
      const view = unwrap(await statusRepo.view(hash, human.customerId));
      expect(view.state).toMatchObject({ status: 'quoting', manualLocked: false });
      const corrected = unwrap(await statusRepo.correct(hash, { customerId: human.customerId, contactId: human.contactId, expectedVersion: view.state!.version, status: 'negotiating', reason: '人工确认已进入谈判', idempotencyKey: randomUUID() }));
      expect(corrected).toMatchObject({ status: 'negotiating', manualLocked: true, source: 'human', signal: 'correction' });
      expect(await recordCustomerStatusEventIn(client, { eventKey: randomUUID(), customerId: human.customerId, contactId: human.contactId, status: 'replied', previousStatus: 'negotiating', source: 'system', signal: 'mail', occurredAt: new Date() })).toBeNull();
      const resumed = unwrap(await statusRepo.resumeAi(hash, { customerId: human.customerId, expectedVersion: corrected.version, idempotencyKey: randomUUID() }));
      expect(resumed).toMatchObject({ status: 'negotiating', manualLocked: false, signal: 'ai_resume' });

      const mail = await fixture('status-mail');
      const occurredAt = new Date().toISOString();
      unwrap(await repo.recordContactMailEvent(hash, { ...mail, eventKey: randomUUID(), mailboxKey: 'inbox', messageKey: `<${randomUUID()}>`, kind: 'replied', direction: 'inbound', occurredAt, subject: 'Re: quote', preview: 'Please proceed', fromEmail: mail.email, toEmails: ['owner@example.invalid'], ccEmails: [] }));
      const mailEvent = (await client.query('SELECT status,previous_status,source,signal,contact_id AS "contactId" FROM crm_customer_status_events WHERE customer_id=$1', [mail.customerId])).rows[0];
      expect(mailEvent).toMatchObject({ status: 'replied', previous_status: 'uncontacted', source: 'system', signal: 'mail' });
      expect(Number(mailEvent.contactId)).toBe(mail.contactId);
      const caseId = randomUUID();
      await client.query("INSERT INTO crm_sales_cases(case_id,customer_id,contact_id,owner_user_id,state,source,verified_at) VALUES($1,$2,$3,$4,'quote_sent','fixture',now())", [caseId, human.customerId, human.contactId, userId]);
      unwrap(await salesCases.transition(hash, caseId, { state: 'won', nextAction: '完成交付' }));
      expect((await client.query('SELECT status,source,signal FROM crm_customer_status_events WHERE customer_id=$1 ORDER BY event_id DESC LIMIT 1', [human.customerId])).rows[0]).toMatchObject({ status: 'won', source: 'human', signal: 'sales_case' });

      const aiCaseId = randomUUID();
      await client.query("INSERT INTO crm_sales_cases(case_id,customer_id,contact_id,owner_user_id,state,source,verified_at) VALUES($1,$2,$3,$4,'replied','fixture',now())", [aiCaseId, mail.customerId, mail.contactId, userId]);
      const applied = await applyDealWonProposalIn(client, { caseId: aiCaseId, customerId: mail.customerId, contactId: mail.contactId, ownerUserId: userId, actorUserId: userId, messageKey: 'fixture-deal-won', signalCode: 'contract_signed', summary: '客户确认合同', evidence: ['contract signed'], confidence: 0.98 });
      expect(applied.applied).toBe(true);
      expect((await client.query('SELECT status,source,signal FROM crm_customer_status_events WHERE customer_id=$1 ORDER BY event_id DESC LIMIT 1', [mail.customerId])).rows[0]).toMatchObject({ status: 'won_pending', source: 'ai', signal: 'deal_won' });
      unwrap(await salesCases.actProposal(hash, aiCaseId, applied.proposalId, 'cancel'));
      expect((await client.query('SELECT status,source,signal FROM crm_customer_status_events WHERE customer_id=$1 ORDER BY event_id DESC LIMIT 1', [mail.customerId])).rows[0]).toMatchObject({ status: 'replied', source: 'human', signal: 'correction' });
      const beforeBounce = (await client.query('SELECT count(*)::int AS n FROM crm_customer_status_events WHERE customer_id=$1', [mail.customerId])).rows[0].n;
      unwrap(await repo.recordContactMailEvent(hash, { ...mail, eventKey: randomUUID(), mailboxKey: 'inbox', messageKey: `<${randomUUID()}>`, kind: 'bounced', direction: 'inbound', occurredAt: new Date(Date.now() + 1000).toISOString(), subject: 'Delivery failure', preview: 'Mailbox unavailable', fromEmail: 'mailer-daemon@example.invalid', toEmails: [mail.email], ccEmails: [] }));
      expect((await client.query('SELECT count(*)::int AS n FROM crm_customer_status_events WHERE customer_id=$1', [mail.customerId])).rows[0].n).toBe(beforeBounce);
      expect(unwrap(await repo.contactDetail(hash, mail)).contact.touchStatus).toBe('replied');
    } finally {
      await client.query('ROLLBACK');
      expect((await client.query('SELECT (SELECT count(*) FROM crm_customer_status_events) AS events')).rows[0]).toEqual(before);
      client.release();
      await pool.end();
    }
  }, 30000);
});
