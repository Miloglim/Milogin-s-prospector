import { describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { readTestDatabaseConfig } from '../../server/adapters/postgres/config';
import { PostgresLeadRepository } from '../../server/adapters/postgres/lead-repository';
import { PostgresTeamRepository } from '../../server/adapters/postgres/team-repository';
import { PostgresTaskRepository } from '../../server/adapters/postgres/task-repository';
import { PostgresContactMailAnalysisRepository } from '../../server/adapters/postgres/contact-mail-analysis-repository';
import { PostgresTeamMonitoringRepository } from '../../server/adapters/postgres/team-monitoring-repository';
import { capabilitiesFor } from '../../server/core/admin';
import type { CrmRole } from '../../server/core/auth';
import type { Result } from '../../server/core/crm';

const enabled = process.env.PROSPECTOR_PG_INTEGRATION === '1';
const log = { write: (level: string, context: string, message: string) => { if (process.env.PROSPECTOR_TEAM_MONITOR_DEBUG === '1') console.error(`[${level}] [${context}] ${message}`); } };

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function clientPool(pool: Pool, client: PoolClient): Pool {
  const map = (sql: string): string => sql === 'BEGIN' ? 'SAVEPOINT team_monitoring_test'
    : sql === 'COMMIT' ? 'RELEASE SAVEPOINT team_monitoring_test'
      : sql === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT team_monitoring_test' : sql;
  return {
    options: pool.options,
    connect: async () => ({ query: (sql: string, values?: unknown[]) => client.query(map(sql), values), release: () => undefined }),
  } as unknown as Pool;
}

describe.runIf(enabled)('CP6 team monitoring rollback PostgreSQL', () => {
  it('scopes aggregates, audits drilldowns, and never mutates ownership', async () => {
    const pool = new Pool(readTestDatabaseConfig());
    const leadRepo = new PostgresLeadRepository(pool, log);
    const teamRepo = new PostgresTeamRepository(pool, log);
    const taskRepo = new PostgresTaskRepository(pool, log);
    const analysisRepo = new PostgresContactMailAnalysisRepository(pool, log);
    unwrap(await leadRepo.migrate());
    unwrap(await teamRepo.migrate());
    unwrap(await taskRepo.migrate());
    unwrap(await leadRepo.migrateAssignmentState());
    unwrap(await leadRepo.migrateLeadMatch());
    unwrap(await analysisRepo.migrate());
    const monitorMigrator = new PostgresTeamMonitoringRepository(pool, log);
    unwrap(await monitorMigrator.migrate());
    unwrap(await monitorMigrator.migrate());

    const client = await pool.connect();
    await client.query('BEGIN');
    try {
      const repo = new PostgresTeamMonitoringRepository(clientPool(pool, client), log);
      const ids: string[] = [];
      async function user(roles: CrmRole[], name: string, identityAdmin = false) {
        const id = randomUUID(), token = Buffer.from(randomUUID() + randomUUID()).toString('base64url').slice(0, 43);
        ids.push(id);
        await client.query('INSERT INTO public.identity_users(user_id,display_name,identity_admin,active) VALUES($1,$2,$3,true)', [id, name, identityAdmin]);
        await client.query('INSERT INTO public.identity_login_emails(user_id,email,verified_at) VALUES($1,$2,now())', [id, `${id}@example.invalid`]);
        if (!identityAdmin) {
          for (const role of roles) await client.query("INSERT INTO public.identity_product_grants(user_id,product_id,role) VALUES($1,'crm',$2)", [id, role]);
          await client.query("INSERT INTO public.identity_product_access(user_id,product_id,scope,capabilities) VALUES($1,'crm',$2,$3)", [id, roles.includes('operations') ? 'shared' : roles.includes('admin') ? 'summary' : 'own', JSON.stringify(capabilitiesFor(roles))]);
        }
        await client.query("INSERT INTO public.identity_sessions(token_hash,user_id,security_revision,expires_at,client) SELECT $1,user_id,security_revision,now()+interval '1 hour','api' FROM public.identity_users WHERE user_id=$2", [tokenHash(token), id]);
        return { id, token };
      }

      const operations = await user(['operations'], 'Monitoring Operations');
      const secondOperations = await user(['operations'], 'Monitoring Operations Two');
      const identityAdmin = await user([], 'Monitoring Identity Admin', true);
      const leaderA = await user(['sales'], 'Leader A');
      const leaderB = await user(['sales'], 'Leader B');
      const memberA1 = await user(['sales'], 'Member A1');
      const memberA2 = await user(['sales'], 'Member A2');
      const memberB1 = await user(['sales'], 'Member B1');
      const company = (await client.query("SELECT unit_id FROM crm_org_units WHERE kind='company' LIMIT 1")).rows[0].unit_id;
      const operationsUnit = (await client.query("INSERT INTO crm_org_units(kind,parent_unit_id,name,created_by) VALUES('operations_group',$1,$2,$3) RETURNING unit_id", [company, `Monitor Ops ${randomUUID()}`, operations.id])).rows[0].unit_id;
      const teamA = (await client.query("INSERT INTO crm_org_units(kind,parent_unit_id,name,created_by) VALUES('sales_team',$1,$2,$3) RETURNING unit_id", [operationsUnit, `Monitor Team A ${randomUUID()}`, operations.id])).rows[0].unit_id;
      const teamB = (await client.query("INSERT INTO crm_org_units(kind,parent_unit_id,name,created_by) VALUES('sales_team',$1,$2,$3) RETURNING unit_id", [operationsUnit, `Monitor Team B ${randomUUID()}`, operations.id])).rows[0].unit_id;
      await client.query("INSERT INTO crm_org_assignments(user_id,unit_id,role,is_primary) VALUES($1,$2,'leader',true),($3,$4,'leader',true)", [leaderA.id, teamA, leaderB.id, teamB]);
      await client.query("INSERT INTO crm_org_assignments(user_id,unit_id,role) VALUES($1,$2,'member'),($3,$2,'member'),($4,$5,'member')", [memberA1.id, teamA, memberA2.id, memberB1.id, teamB]);

      async function contact(ownerId: string | null, origin: 'personal' | 'operations', touch: string, stage: string, label: string, own = ownerId !== null) {
        const companyId = (await client.query('INSERT INTO companies(name,country) VALUES($1,$2) RETURNING id', [`${label}-${randomUUID()}`, 'CN'])).rows[0].id;
        const customerId = randomUUID();
        await client.query("INSERT INTO crm_customers(customer_id,company_id,source,customer_key,source_detail,created_by,origin,owner_user_id,relationship_stage,state) VALUES($1,$2,'monitoring',$3,$4,$5,$6,$7,$8,$9)", [customerId, companyId, customerId, label, operations.id, origin, origin === 'personal' ? ownerId : null, stage, origin === 'personal' ? 'owned' : 'published']);
        const contactRow = (await client.query('INSERT INTO contacts(email,first_name,company_id,crm_touch_status) VALUES($1,$2,$3,$4) RETURNING id', [`${randomUUID()}@example.invalid`, label, companyId, touch])).rows[0];
        await client.query('INSERT INTO crm_customer_contacts(customer_id,contact_id) VALUES($1,$2)', [customerId, contactRow.id]);
        if (ownerId && own && origin === 'operations') await client.query("INSERT INTO crm_contact_ownership(contact_id,customer_id,owner_user_id,source_org_unit_id,created_by) VALUES($1,$2,$3,$4,$5)", [contactRow.id, customerId, ownerId, teamA, operations.id]);
        return { contactId: contactRow.id as number, customerId, companyId: companyId as number };
      }

      const personalA = await contact(memberA1.id, 'personal', 'contacted', 'reaching', 'Personal A');
      const assignedA = await contact(memberA1.id, 'operations', 'replied', 'quoting', 'Assigned A');
      const personalA2 = await contact(memberA2.id, 'personal', 'uncontacted', 'cold', 'Personal A2');
      const personalB = await contact(memberB1.id, 'personal', 'bounced', 'trial', 'Personal B');
      const unassignedOperations = await contact(null, 'operations', 'uncontacted', 'cold', 'Operations Pool', false);
      const pendingAssignment = await contact(null, 'operations', 'uncontacted', 'cold', 'Pending Assignment', false);

      const assignedEmail = (await client.query('SELECT email FROM contacts WHERE id=$1', [assignedA.contactId])).rows[0].email;
      const eventId = (await client.query(`INSERT INTO crm_contact_mail_events(
        actor_id,contact_id,customer_id,event_key,mailbox_key,message_key,kind,direction,occurred_at,
        subject,preview,from_email,to_emails,cc_emails,digest
      ) VALUES($1,$2,$3,$4,'monitoring','message-1','replied','inbound',now(),'Quotation request','Please quote','customer@example.invalid','["sales@example.invalid"]'::jsonb,'[]'::jsonb,$5) RETURNING event_id`,
      [memberA1.id, assignedA.contactId, assignedA.customerId, randomUUID(), 'a'.repeat(64)])).rows[0].event_id as string;
      const analysisId = (await client.query(`INSERT INTO crm_contact_mail_analyses(
        actor_id,event_id,contact_id,customer_id,mailbox_key,message_key,content_hash,thread_key,
        analyzer_version,input_sequence,source,relevance,classification,contact_state,summary,signals,
        requires_action,next_action,priority,due_hint,confidence,evidence,human_locked,idempotency_key,request_digest,is_current
      ) VALUES($1,$2,$3,$4,'monitoring','message-1',$5,'quotation-request','rule',1,'rule','customer_business','replied','replied',
        'Customer requested a quotation','[{"code":"quote_request","label":"Quote","confidence":0.96,"evidence":"Please quote"}]'::jsonb,
        true,'Send quotation','urgent','today',0.96,'["Please quote"]'::jsonb,false,$6,$7,true) RETURNING analysis_id`,
      [memberA1.id, eventId, assignedA.contactId, assignedA.customerId, 'b'.repeat(64), randomUUID(), 'c'.repeat(64)])).rows[0].analysis_id as string;
      await client.query("INSERT INTO crm_followup_tasks(customer_id,title,due_at,created_by) VALUES($1,'Send quotation',now()-interval '1 hour',$2)", [personalA.customerId, memberA1.id]);
      await client.query("INSERT INTO crm_team_attention_items(target_member_user_id,source_supervisor_user_id,customer_id,contact_id,mail_event_id,analysis_id,reason,priority,note) VALUES($1,$2,$3,$4,$5,$6,'important_reply','urgent','Handle today')", [memberA1.id, leaderA.id, assignedA.customerId, assignedA.contactId, eventId, analysisId]);
      await client.query("INSERT INTO crm_contact_assignment_requests(contact_id,customer_id,target_user_id,actor_id,status) VALUES($1,$2,$3,$4,'pending')", [pendingAssignment.contactId, pendingAssignment.customerId, memberA1.id, operations.id]);
      await client.query("INSERT INTO crm_contact_assignment_requests(contact_id,customer_id,target_user_id,actor_id,status,decided_at) VALUES($1,$2,$3,$4,'pending_transfer',now())", [assignedA.contactId, assignedA.customerId, memberA1.id, operations.id]);

      const leaderOverview = unwrap(await repo.overview(tokenHash(leaderA.token), { limit: 20, offset: 0, unitLimit: 20, unitOffset: 0 }));
      expect(leaderOverview.scope).toBe('leader');
      expect(leaderOverview.units.items.map(item => item.unitId)).toEqual([teamA]);
      expect(leaderOverview.members.items.map(item => item.userId)).toEqual(expect.arrayContaining([memberA1.id, memberA2.id]));
      expect(leaderOverview.members.items.map(item => item.userId)).not.toContain(memberB1.id);
      const summaryA1 = leaderOverview.members.items.find(item => item.userId === memberA1.id)!;
      expect(summaryA1).not.toHaveProperty('score');
      expect(summaryA1).not.toHaveProperty('grade');
      expect(summaryA1.counts).toMatchObject({ contacts: 2, contacted: 1, replied: 1, openActions: 1, overdueActions: 1, importantReplies: 1, openAttention: 1, pendingAssignments: 1, pendingTransfers: 1 });
      expect(summaryA1.stages).toMatchObject({ reaching: 1, quoting: 1 });
      expect(summaryA1.rates.replyRate).toBe(0.5);
      expect(leaderOverview.importantReplies[0]).toMatchObject({ eventId, classification: 'replied', priority: 'urgent' });

      const firstPage = unwrap(await repo.overview(tokenHash(operations.token), { limit: 1, offset: 0, unitLimit: 20, unitOffset: 0 }));
      const secondPage = unwrap(await repo.overview(tokenHash(operations.token), { limit: 1, offset: 1, unitLimit: 20, unitOffset: 0 }));
      expect(firstPage.members.total).toBeGreaterThanOrEqual(3);
      expect(firstPage.members.items).toHaveLength(1);
      expect(secondPage.members.items[0]!.userId).not.toBe(firstPage.members.items[0]!.userId);
      expect(firstPage.units.items.map(item => item.unitId)).toEqual(expect.arrayContaining([teamA, teamB]));
      expect(firstPage.pool!.unassignedOperationsContacts).toBeGreaterThanOrEqual(1);
      expect(firstPage.pool!.pendingAssignmentRequests).toBeGreaterThanOrEqual(1);
      const operationsMember = unwrap(await repo.member(tokenHash(operations.token), memberA1.id, 20, 0));
      expect(operationsMember.member.counts.contacts).toBe(1);
      expect(operationsMember.recentActions.find(action => action.kind === 'task' && action.title === 'Send quotation')).toBeUndefined();
      expect(operationsMember.attention.map(item => item.itemId)).toHaveLength(1);

      const secondOperationsView = unwrap(await repo.overview(tokenHash(secondOperations.token), { limit: 20, offset: 0, unitLimit: 20, unitOffset: 0 }));
      expect(secondOperationsView.units.items.map(item => item.unitId)).toEqual(expect.arrayContaining([teamA, teamB]));
      const superadminView = unwrap(await repo.overview(tokenHash(identityAdmin.token), { limit: 20, offset: 0, unitLimit: 20, unitOffset: 0 }));
      expect(superadminView.scope).toBe('superadmin');
      expect(superadminView.members.items.map(item => item.userId)).toEqual(expect.arrayContaining([memberA1.id, memberA2.id, memberB1.id]));
      expect(superadminView.units.items.map(item => item.unitId)).toEqual(expect.arrayContaining([teamA, teamB]));
      expect(await repo.overview(tokenHash(memberA1.token), { limit: 20, offset: 0, unitLimit: 20, unitOffset: 0 }))
        .toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
      expect(await repo.member(tokenHash(leaderA.token), memberB1.id, 20, 0)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });

      const ownershipBefore = (await client.query('SELECT contact_id,owner_user_id,started_at,ended_at FROM crm_contact_ownership ORDER BY ownership_id')).rows;
      const auditBefore = Number((await client.query('SELECT count(*)::int AS count FROM crm_team_monitoring_audits')).rows[0].count);
      const contactDetail = unwrap(await repo.contact(tokenHash(leaderA.token), assignedA.contactId, assignedA.customerId, 20, 0));
      const mailDetail = unwrap(await repo.mail(tokenHash(leaderA.token), eventId, assignedA.contactId, assignedA.customerId));
      expect(contactDetail.mail.total).toBe(1);
      expect(mailDetail.mail).toMatchObject({ eventId, classification: 'replied', source: 'rule' });
      expect(JSON.stringify(mailDetail)).not.toMatch(/body|attachment/i);
      expect(Number((await client.query('SELECT count(*)::int AS count FROM crm_team_monitoring_audits')).rows[0].count)).toBe(auditBefore + 2);
      expect((await client.query('SELECT contact_id,owner_user_id,started_at,ended_at FROM crm_contact_ownership ORDER BY ownership_id')).rows).toEqual(ownershipBefore);
      expect(await repo.contact(tokenHash(operations.token), personalA.contactId, personalA.customerId, 20, 0)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
      expect(await repo.contact(tokenHash(leaderA.token), personalB.contactId, personalB.customerId, 20, 0)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
      const adminPersonal = unwrap(await repo.contact(tokenHash(identityAdmin.token), personalB.contactId, personalB.customerId, 20, 0));
      expect(adminPersonal).toMatchObject({ contactId: personalB.contactId, ownerUserId: memberB1.id, scope: 'superadmin' });

      const bodyColumns = await client.query(`SELECT column_name FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name IN ('crm_contact_mail_events','crm_contact_mail_analyses')
          AND column_name IN ('body','raw_body','html_body','attachments','attachment_data')`);
      expect(bodyColumns.rows).toEqual([]);
      expect((await client.query("SELECT count(*)::int AS count FROM crm_schema_migrations WHERE version='061-team-monitoring'")).rows[0].count).toBe(1);
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await pool.end();
    }
  }, 60000);
});
