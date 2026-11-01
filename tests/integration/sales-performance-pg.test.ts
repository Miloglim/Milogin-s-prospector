import { describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { readTestDatabaseConfig } from '../../server/adapters/postgres/config';
import { PostgresContactMailAnalysisRepository } from '../../server/adapters/postgres/contact-mail-analysis-repository';
import { PostgresLeadRepository } from '../../server/adapters/postgres/lead-repository';
import { PostgresOpportunityRepository } from '../../server/adapters/postgres/opportunity-repository';
import { PostgresSalesPerformanceRepository } from '../../server/adapters/postgres/sales-performance-repository';
import { PostgresTaskRepository } from '../../server/adapters/postgres/task-repository';
import { PostgresTeamMonitoringRepository } from '../../server/adapters/postgres/team-monitoring-repository';
import { PostgresTeamRepository } from '../../server/adapters/postgres/team-repository';
import { capabilitiesFor } from '../../server/core/admin';
import type { CrmRole } from '../../server/core/auth';
import type { Result } from '../../server/core/crm';

const enabled = process.env.PROSPECTOR_PG_INTEGRATION === '1';
const FROM = '2026-01-01T00:00:00.000Z';
const TO = '2026-02-01T00:00:00.000Z';
const START = Date.parse(FROM);
const SECOND = 1000;
const HOUR = 3600 * SECOND;
const log = {
  write: (level: string, context: string, message: string) => {
    if (process.env.PROSPECTOR_SALES_PERFORMANCE_DEBUG === '1') console.error(`[${level}] [${context}] ${message}`);
  },
};

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function at(seconds: number): string {
  return new Date(START + seconds * SECOND).toISOString();
}

function clientPool(pool: Pool, client: PoolClient): Pool {
  const map = (sql: string): string => sql.startsWith('BEGIN') ? 'SAVEPOINT sales_performance_test'
    : sql === 'COMMIT' ? 'RELEASE SAVEPOINT sales_performance_test'
      : sql === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT sales_performance_test' : sql;
  return {
    options: pool.options,
    connect: async () => ({ query: (sql: string, values?: unknown[]) => client.query(map(sql), values), release: () => undefined }),
  } as unknown as Pool;
}

describe.runIf(enabled)('CP7 sales performance rollback PostgreSQL', () => {
  it('derives metrics, strata, permissions and audited grades without persisted scores', async () => {
    const pool = new Pool(readTestDatabaseConfig());
    const leadRepo = new PostgresLeadRepository(pool, log);
    const teamRepo = new PostgresTeamRepository(pool, log);
    const taskRepo = new PostgresTaskRepository(pool, log);
    const analysisRepo = new PostgresContactMailAnalysisRepository(pool, log);
    const monitoringRepo = new PostgresTeamMonitoringRepository(pool, log);
    const opportunityRepo = new PostgresOpportunityRepository(pool, log);
    unwrap(await leadRepo.migrate());
    unwrap(await teamRepo.migrate());
    unwrap(await taskRepo.migrate());
    unwrap(await leadRepo.migrateAssignmentState());
    unwrap(await leadRepo.migrateLeadMatch());
    unwrap(await analysisRepo.migrate());
    unwrap(await monitoringRepo.migrate());
    unwrap(await opportunityRepo.migrate());
    const migrator = new PostgresSalesPerformanceRepository(pool, log);
    unwrap(await migrator.migrate());
    unwrap(await migrator.migrate());

    const client = await pool.connect();
    await client.query('BEGIN');
    try {
      const repo = new PostgresSalesPerformanceRepository(clientPool(pool, client), log);
      async function user(roles: CrmRole[], name: string, identityAdmin = false) {
        const id = randomUUID();
        const token = Buffer.from(randomUUID() + randomUUID()).toString('base64url').slice(0, 43);
        await client.query('INSERT INTO public.identity_users(user_id,display_name,identity_admin,active) VALUES($1,$2,$3,true)', [id, name, identityAdmin]);
        await client.query('INSERT INTO public.identity_login_emails(user_id,email,verified_at) VALUES($1,$2,now())', [id, `${id}@example.invalid`]);
        if (!identityAdmin) {
          for (const role of roles) await client.query("INSERT INTO public.identity_product_grants(user_id,product_id,role) VALUES($1,'crm',$2)", [id, role]);
          await client.query("INSERT INTO public.identity_product_access(user_id,product_id,scope,capabilities) VALUES($1,'crm',$2,$3)", [
            id, roles.includes('operations') ? 'shared' : roles.includes('admin') ? 'summary' : 'own', JSON.stringify(capabilitiesFor(roles)),
          ]);
        }
        await client.query("INSERT INTO public.identity_sessions(token_hash,user_id,security_revision,expires_at,client) SELECT $1,user_id,security_revision,now()+interval '1 hour','api' FROM public.identity_users WHERE user_id=$2", [tokenHash(token), id]);
        return { id, token };
      }

      const operations = await user(['operations'], 'Performance Operations');
      const identityAdmin = await user([], 'Performance Identity Admin', true);
      const leaderA = await user(['sales'], 'Performance Leader A');
      const leaderB = await user(['sales'], 'Performance Leader B');
      const memberA1 = await user(['sales'], 'Performance Member A1');
      const memberA2 = await user(['sales'], 'Performance Member A2');
      const memberB1 = await user(['sales'], 'Performance Member B1');
      const auditor = await user(['auditor'], 'Performance Auditor');

      const companyUnit = (await client.query("SELECT unit_id FROM crm_org_units WHERE kind='company' LIMIT 1")).rows[0].unit_id;
      const operationsUnit = (await client.query("INSERT INTO crm_org_units(kind,parent_unit_id,name,created_by) VALUES('operations_group',$1,$2,$3) RETURNING unit_id", [companyUnit, `Performance Ops ${randomUUID()}`, operations.id])).rows[0].unit_id;
      const teamA = (await client.query("INSERT INTO crm_org_units(kind,parent_unit_id,name,created_by) VALUES('sales_team',$1,$2,$3) RETURNING unit_id", [operationsUnit, `Performance Team A ${randomUUID()}`, operations.id])).rows[0].unit_id;
      const teamB = (await client.query("INSERT INTO crm_org_units(kind,parent_unit_id,name,created_by) VALUES('sales_team',$1,$2,$3) RETURNING unit_id", [operationsUnit, `Performance Team B ${randomUUID()}`, operations.id])).rows[0].unit_id;
      await client.query("INSERT INTO crm_org_assignments(user_id,unit_id,role,is_primary) VALUES($1,$2,'leader',true),($3,$4,'leader',true)", [leaderA.id, teamA, leaderB.id, teamB]);
      await client.query("INSERT INTO crm_org_assignments(user_id,unit_id,role) VALUES($1,$2,'member'),($3,$2,'member'),($4,$5,'member')", [memberA1.id, teamA, memberA2.id, memberB1.id, teamB]);

      async function contactFixture(input: {
        ownerId: string; origin: 'personal' | 'operations'; source: string; country: string; label: string; startedAt: string;
      }) {
        const companyId = (await client.query('INSERT INTO companies(name,country) VALUES($1,$2) RETURNING id', [`${input.label}-${randomUUID()}`, input.country])).rows[0].id;
        const customerId = randomUUID();
        await client.query(`INSERT INTO crm_customers(customer_id,company_id,source,customer_key,source_detail,created_by,origin,owner_user_id,relationship_stage,state,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,'reaching','owned',$9)`, [
          customerId, companyId, input.source, customerId, input.label, operations.id, input.origin, input.ownerId, input.startedAt,
        ]);
        const contactId = (await client.query(`INSERT INTO contacts(email,first_name,company_id,crm_touch_status,created_at)
          VALUES($1,$2,$3,'replied',$4) RETURNING id`, [`${randomUUID()}@example.invalid`, input.label, companyId, input.startedAt])).rows[0].id as number;
        await client.query('INSERT INTO crm_customer_contacts(customer_id,contact_id) VALUES($1,$2)', [customerId, contactId]);
        if (input.origin === 'operations') {
          await client.query(`INSERT INTO crm_contact_ownership(contact_id,customer_id,owner_user_id,source_org_unit_id,started_at,created_by)
            VALUES($1,$2,$3,$4,$5,$6)`, [contactId, customerId, input.ownerId, operationsUnit, input.startedAt, operations.id]);
        }
        return { customerId, contactId, companyId: Number(companyId) };
      }

      const claims = [] as Awaited<ReturnType<typeof contactFixture>>[];
      for (let index = 0; index < 5; index += 1) {
        claims.push(await contactFixture({
          ownerId: memberA1.id, origin: 'operations', source: index < 3 ? 'source-cn' : 'source-export',
          country: index < 3 ? 'CN' : index === 3 ? 'US' : 'DE', label: `Performance A1 ${index + 1}`, startedAt: FROM,
        }));
      }
      const otherMember = await contactFixture({ ownerId: memberA2.id, origin: 'operations', source: 'source-team', country: 'BR', label: 'Performance A2', startedAt: FROM });
      const otherTeam = await contactFixture({ ownerId: memberB1.id, origin: 'operations', source: 'source-b', country: 'GB', label: 'Performance B1', startedAt: FROM });
      const personal = await contactFixture({ ownerId: memberA1.id, origin: 'personal', source: 'personal', country: 'FR', label: 'Performance Personal', startedAt: FROM });
      const noSignal = await contactFixture({ ownerId: memberA2.id, origin: 'operations', source: 'source-empty', country: 'BR', label: 'Performance Empty', startedAt: FROM });

      const batchOne = randomUUID(), batchTwo = randomUUID();
      await client.query("INSERT INTO crm_import_batches(batch_id,actor_id,source,source_detail,mapping) VALUES($1,$2,'source-cn','January CN batch','{}'),($3,$2,'source-export','January Export batch','{}')", [batchOne, operations.id, batchTwo]);
      for (let index = 0; index < claims.length; index += 1) {
        const batchId = index < 3 ? batchOne : batchTwo;
        await client.query("INSERT INTO crm_import_rows(row_id,batch_id,row_index,customer_key,raw_row,customer_id,status) VALUES($1,$2,$3,$4,'{}',$5,'created')", [
          randomUUID(), batchId, index, `performance-${index}`, claims[index]!.customerId,
        ]);
      }

      await client.query(`INSERT INTO crm_followup_tasks(customer_id,title,due_at,status,created_by,completed_at,completed_by,feedback)
        VALUES($1,'First touch',$2,'completed',$3,$4,$3,'Completed first action')`, [
        claims[0]!.customerId, at(2 * HOUR), memberA1.id, at(50),
      ]);
      for (let index = 1; index < claims.length; index += 1) {
        await client.query(`INSERT INTO crm_shared_activities(customer_id,interaction_id,actor_id,note,method,occurred_at,recorded_at,created_at,contact_id,contact_status,stage)
          VALUES($1,NULL,$2,'Outbound first action','email',$3,$3,$3,$4,'contacted','reaching')`, [
          claims[index]!.customerId, memberA1.id, at(index * 100), claims[index]!.contactId,
        ]);
      }

      async function mailFixture(input: {
        fixture: { customerId: string; contactId: number }; at: string; classification: 'replied' | 'bounced' | 'autoreply';
        relevance: 'customer_business' | 'vendor' | 'internal'; kind: 'replied' | 'bounced' | 'autoreply'; actorId: string; label: string;
      }) {
        const eventId = randomUUID(), mailboxKey = `mailbox-${randomUUID()}`, messageKey = `message-${randomUUID()}`, contentHash = randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64);
        await client.query(`INSERT INTO crm_contact_mail_events(event_id,actor_id,contact_id,customer_id,event_key,mailbox_key,message_key,kind,direction,
          occurred_at,subject,preview,from_email,to_emails,cc_emails,digest,recorded_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,'inbound',$9,$10,$11,$12,'[]','[]',$13,$9)`, [
          eventId, input.actorId, input.fixture.contactId, input.fixture.customerId, `event-${eventId}`, mailboxKey, messageKey,
          input.kind, input.at, input.label, input.label, `contact-${input.fixture.contactId}@example.invalid`, 'a'.repeat(64),
        ]);
        await client.query(`INSERT INTO crm_contact_mail_analyses(actor_id,event_id,contact_id,customer_id,mailbox_key,message_key,content_hash,thread_key,
          analyzer_version,input_sequence,source,relevance,classification,contact_state,summary,signals,requires_action,next_action,priority,due_hint,
          confidence,evidence,human_locked,idempotency_key,request_digest,is_current,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pg-fixture-v1',1,'rule',$9,$10,$11,$12,'[]',false,NULL,'normal',NULL,0.99,'[]',false,$13,$14,true,$15)`, [
          input.actorId, eventId, input.fixture.contactId, input.fixture.customerId, mailboxKey, messageKey, contentHash,
          `thread-${input.fixture.contactId}`, input.relevance, input.classification,
          input.classification === 'replied' ? 'replied' : input.classification, input.label, `analysis-${eventId}`, 'b'.repeat(64), input.at,
        ]);
      }

      for (let index = 0; index < claims.length; index += 1) {
        await mailFixture({
          fixture: claims[index]!, at: at(600 + index * 100), classification: 'replied', relevance: 'customer_business', kind: 'replied',
          actorId: memberA1.id, label: `Valid reply ${index + 1}`,
        });
      }
      await mailFixture({ fixture: claims[0]!, at: at(10), classification: 'replied', relevance: 'vendor', kind: 'replied', actorId: memberA1.id, label: 'Vendor message' });
      await mailFixture({ fixture: claims[0]!, at: at(15), classification: 'replied', relevance: 'internal', kind: 'replied', actorId: memberA1.id, label: 'Internal message' });
      await mailFixture({ fixture: claims[0]!, at: at(20), classification: 'bounced', relevance: 'customer_business', kind: 'bounced', actorId: memberA1.id, label: 'Bounce message' });
      await mailFixture({ fixture: claims[0]!, at: at(25), classification: 'autoreply', relevance: 'customer_business', kind: 'autoreply', actorId: memberA1.id, label: 'Automatic reply' });

      const closedDurations = [1200, 1400, 1600, 1800, 2000];
      for (let index = 0; index < closedDurations.length; index += 1) {
        const fixture = claims[Math.min(index, 3)]!;
        const opportunityId = randomUUID();
        const closedAt = at(closedDurations[index]!);
        await client.query(`INSERT INTO crm_opportunities(opportunity_id,customer_id,title,source,stage,amount,currency,evidence,created_by,created_at,updated_at,closed_at,closed_by)
          VALUES($1,$2,$3,'performance','closed_won',1000,'USD','Signed order',$4,$5,$5,$5,$4)`, [
          opportunityId, fixture.customerId, `Won ${index + 1}`, memberA1.id, closedAt,
        ]);
        await client.query(`INSERT INTO crm_opportunity_stage_history(opportunity_id,from_stage,to_stage,actor_id,occurred_at,amount,currency,evidence)
          VALUES($1,'booking_confirmed','closed_won',$2,$3,1000,'USD','Signed order')`, [opportunityId, memberA1.id, closedAt]);
      }

      expect(await repo.performance(tokenHash(memberA1.token), {
        from: FROM, to: TO, groupBy: 'lead', limit: 20, offset: 0,
      })).toMatchObject({ error: { code: 'FORBIDDEN' } });
      expect(await repo.performance(tokenHash(leaderA.token), {
        from: FROM, to: TO, groupBy: 'lead', limit: 20, offset: 0,
      })).toMatchObject({ error: { code: 'FORBIDDEN' } });
      const leadPage = unwrap(await repo.performance(tokenHash(identityAdmin.token), {
        from: FROM, to: TO, groupBy: 'lead', memberUserId: memberA1.id, limit: 20, offset: 0,
      }));
      expect(leadPage.scope).toBe('superadmin');
      const a1 = leadPage.items.find(item => item.memberUserId === memberA1.id)!;
      expect(a1).toMatchObject({
        claimCount: 6, customerCount: 6, completedTaskCount: 1, validReplyCount: 5, wonOpportunityCount: 5,
        metrics: {
          claimToFirstAction: { sampleCount: 5, medianSeconds: 200, p90Seconds: 360, sufficient: true },
          claimToValidReply: { sampleCount: 5, medianSeconds: 800, p90Seconds: 960, sufficient: true },
          claimToWon: { sampleCount: 5, medianSeconds: 1600, p90Seconds: 1920, sufficient: true },
          repeatPurchase: { repeatPurchaseCount: 1, repeatPurchaseCustomers: 1, wonCustomers: 4 },
        },
      });
      expect(a1.metrics.repeatPurchase.rate).toMatchObject({ rate: 0.25, sampleCount: 4, sufficient: false });
      const beyondPerformancePage = unwrap(await repo.performance(tokenHash(identityAdmin.token), {
        from: FROM, to: TO, groupBy: 'lead', memberUserId: memberA1.id, limit: 20, offset: 100,
      }));
      expect(beyondPerformancePage).toMatchObject({ items: [], total: 1 });

      const byCountry = unwrap(await repo.performance(tokenHash(identityAdmin.token), {
        from: FROM, to: TO, groupBy: 'country', memberUserId: memberA1.id, limit: 20, offset: 0,
      }));
      expect(byCountry.items.map(item => [item.label, item.claimCount]).sort()).toEqual([['CN', 3], ['DE', 1], ['FR', 1], ['US', 1]]);
      const bySource = unwrap(await repo.performance(tokenHash(identityAdmin.token), {
        from: FROM, to: TO, groupBy: 'source', memberUserId: memberA1.id, limit: 20, offset: 0,
      }));
      expect(bySource.items.map(item => [item.label, item.claimCount]).sort()).toEqual([['personal', 1], ['source-cn', 3], ['source-export', 2]]);
      const byBatch = unwrap(await repo.performance(tokenHash(identityAdmin.token), {
        from: FROM, to: TO, groupBy: 'batch', memberUserId: memberA1.id, limit: 20, offset: 0,
      }));
      expect(byBatch.items.map(item => item.claimCount).sort()).toEqual([1, 2, 3]);

      expect(await repo.performance(tokenHash(memberA1.token), {
        from: FROM, to: TO, groupBy: 'lead', memberUserId: memberA2.id, limit: 20, offset: 0,
      })).toMatchObject({ error: { code: 'FORBIDDEN' } });
      const operationsView = unwrap(await repo.performance(tokenHash(operations.token), {
        from: FROM, to: TO, groupBy: 'lead', limit: 20, offset: 0,
      }));
      expect(operationsView.scope).toBe('operations');
      expect(operationsView.items.map(item => item.memberUserId)).toEqual(expect.arrayContaining([memberA1.id, memberA2.id, memberB1.id]));
      expect(operationsView.items.find(item => item.memberUserId === memberA1.id)!.claimCount).toBe(5);
      const operationsPersonal = unwrap(await repo.performance(tokenHash(operations.token), {
        from: FROM, to: TO, groupBy: 'country', country: 'FR', limit: 20, offset: 0,
      }));
      expect(operationsPersonal.items).toEqual([]);
      const superadminView = unwrap(await repo.performance(tokenHash(identityAdmin.token), {
        from: FROM, to: TO, groupBy: 'country', country: 'FR', limit: 20, offset: 0,
      }));
      expect(superadminView).toMatchObject({ scope: 'superadmin', total: 1 });
      expect(superadminView.items[0]).toMatchObject({ label: 'FR', claimCount: 1 });
      expect(await repo.performance(tokenHash(auditor.token), { from: FROM, to: TO, groupBy: 'lead', limit: 20, offset: 0 }))
        .toMatchObject({ error: { code: 'FORBIDDEN' } });

      const gradesBefore = unwrap(await repo.customerGrades(tokenHash(leaderA.token), {
        from: FROM, to: TO, memberUserId: memberA1.id, limit: 20, offset: 0,
      }));
      expect(gradesBefore.items.find(item => item.customerId === claims[0]!.customerId)).toMatchObject({
        computedGrade: 'A', effectiveGrade: 'A', source: 'computed',
      });
      const gradeTarget = gradesBefore.items.find(item => item.customerId === claims[4]!.customerId)!;
      expect(gradeTarget).toMatchObject({ computedGrade: 'B', effectiveGrade: 'B', source: 'computed' });
      expect(gradeTarget.signals).toMatchObject({ validReplyCount: 1, wonOpportunityCount: 0, repeatPurchaseCount: 0 });
      const beyondGradePage = unwrap(await repo.customerGrades(tokenHash(leaderA.token), {
        from: FROM, to: TO, memberUserId: memberA1.id, limit: 20, offset: 100,
      }));
      expect(beyondGradePage).toMatchObject({ items: [], total: 6 });
      const emptyGrade = unwrap(await repo.customerGrades(tokenHash(leaderA.token), {
        from: FROM, to: TO, customerId: noSignal.customerId, limit: 20, offset: 0,
      })).items[0]!;
      expect(emptyGrade).toMatchObject({ computedGrade: 'C', effectiveGrade: 'C', source: 'computed' });

      const mutationBefore = (await client.query(`SELECT customer.owner_user_id AS "ownerUserId",customer.relationship_stage AS stage,
        contact.crm_touch_status AS "touchStatus" FROM crm_customers customer
        JOIN crm_customer_contacts link USING(customer_id) JOIN contacts contact ON contact.id=link.contact_id
        WHERE customer.customer_id=$1`, [claims[4]!.customerId])).rows;
      const auditBefore = Number((await client.query('SELECT count(*)::int AS total FROM crm_customer_grade_override_audits')).rows[0].total);
      const setInput = { customerId: claims[4]!.customerId, expectedVersion: 0, grade: 'A' as const, reason: 'Strategic account review', idempotencyKey: 'performance-grade:set:1' };
      const setResult = unwrap(await repo.setCustomerGradeOverride(tokenHash(leaderA.token), setInput));
      expect(setResult.override).toMatchObject({ grade: 'A', actorId: leaderA.id, version: 1, reason: 'Strategic account review' });
      const replay = unwrap(await repo.setCustomerGradeOverride(tokenHash(leaderA.token), setInput));
      expect(replay.override?.version).toBe(1);
      expect(Number((await client.query('SELECT count(*)::int AS total FROM crm_customer_grade_override_audits')).rows[0].total)).toBe(auditBefore + 1);
      const overridden = unwrap(await repo.customerGrades(tokenHash(leaderA.token), {
        from: FROM, to: TO, customerId: claims[4]!.customerId, limit: 20, offset: 0,
      })).items[0]!;
      expect(overridden).toMatchObject({ computedGrade: 'B', effectiveGrade: 'A', source: 'manual' });
      expect(overridden.override).toMatchObject({ grade: 'A', actorId: leaderA.id, version: 1 });
      expect(await repo.setCustomerGradeOverride(tokenHash(memberA1.token), {
        customerId: claims[4]!.customerId, expectedVersion: 0, grade: 'C', reason: 'Sales override', idempotencyKey: 'performance-grade:sales',
      })).toMatchObject({ error: { code: 'NOT_FOUND' } });
      expect(await repo.setCustomerGradeOverride(tokenHash(operations.token), {
        customerId: personal.customerId, expectedVersion: 0, grade: 'C', reason: 'Personal override', idempotencyKey: 'performance-grade:ops-personal',
      })).toMatchObject({ error: { code: 'NOT_FOUND' } });
      expect(await repo.setCustomerGradeOverride(tokenHash(leaderA.token), {
        customerId: otherTeam.customerId, expectedVersion: 0, grade: 'C', reason: 'Other team override', idempotencyKey: 'performance-grade:other-team',
      })).toMatchObject({ error: { code: 'NOT_FOUND' } });

      const cleared = unwrap(await repo.clearCustomerGradeOverride(tokenHash(leaderA.token), {
        customerId: claims[4]!.customerId, expectedVersion: 1, reason: 'Return to query-derived grade', idempotencyKey: 'performance-grade:clear:1',
      }));
      expect(cleared.override).toBeNull();
      expect(Number((await client.query('SELECT count(*)::int AS total FROM crm_customer_grade_override_audits')).rows[0].total)).toBe(auditBefore + 2);
      const afterClear = unwrap(await repo.customerGrades(tokenHash(leaderA.token), {
        from: FROM, to: TO, customerId: claims[4]!.customerId, limit: 20, offset: 0,
      })).items[0]!;
      expect(afterClear).toMatchObject({ computedGrade: 'B', effectiveGrade: 'B', source: 'computed', override: null });
      const mutationAfter = (await client.query(`SELECT customer.owner_user_id AS "ownerUserId",customer.relationship_stage AS stage,
        contact.crm_touch_status AS "touchStatus" FROM crm_customers customer
        JOIN crm_customer_contacts link USING(customer_id) JOIN contacts contact ON contact.id=link.contact_id
        WHERE customer.customer_id=$1`, [claims[4]!.customerId])).rows;
      expect(mutationAfter).toEqual(mutationBefore);

      const scoreTables = await client.query(`SELECT table_name FROM information_schema.tables
        WHERE table_schema=current_schema() AND (table_name ILIKE 'crm_sales_performance%' OR table_name ILIKE 'crm_customer_grade_score%')`);
      expect(scoreTables.rows).toEqual([]);
      const scoreColumns = await client.query(`SELECT column_name FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name IN (
          'crm_customer_grade_overrides','crm_customer_grade_override_audits','crm_customer_grade_override_idempotency'
        ) AND column_name ILIKE '%score%'`);
      expect(scoreColumns.rows).toEqual([]);
      expect((await client.query("SELECT count(*)::int AS total FROM crm_schema_migrations WHERE version='062-sales-performance-customer-grade'")).rows[0].total).toBe(1);
      expect((await client.query("SELECT count(*)::int AS total FROM crm_customer_grade_overrides WHERE customer_id=$1", [claims[4]!.customerId])).rows[0].total).toBe(0);
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await pool.end();
    }
  }, 60000);
});
