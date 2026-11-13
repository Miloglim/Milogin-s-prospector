import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { capabilitiesFor } from '../../server/core/admin';
import { DEAL_OVERLAP_EVENT } from '../../server/core/lead-ingress';
import type { CrmRole } from '../../server/core/auth';
import type { Result } from '../../server/core/crm';
import { tokenAdapter } from '../../server/adapters/password';
import { readTestDatabaseConfig } from '../../server/adapters/postgres/config';
import { PostgresAuthRepository } from '../../server/adapters/postgres/auth-repository';
import { migrateLeadOverlapSchema } from '../../server/adapters/postgres/lead-overlap-schema';
import { PostgresLeadRepository } from '../../server/adapters/postgres/lead-repository';
import { PostgresNotificationRepository } from '../../server/adapters/postgres/notification-repository';
import { PostgresOpportunityRepository } from '../../server/adapters/postgres/opportunity-repository';
import { PostgresCrmRepository } from '../../server/adapters/postgres/repository';
import { createLeadService } from '../../server/services/leads';
import { createOpportunityService } from '../../server/services/opportunities';

const TIMEOUT = 30000;
const SESSION_SECONDS = 3600;
const log = { write: () => {} };

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
}

type Member = { id: string; token: string };

describe.runIf(process.env.PROSPECTOR_PG_INTEGRATION === '1')('lead scope overlap PostgreSQL', () => {
  let pool: Pool;
  let leads: ReturnType<typeof createLeadService>;
  let opportunities: ReturnType<typeof createOpportunityService>;
  let notifications: PostgresNotificationRepository;
  let userA: Member;
  let userB: Member;
  const source = `overlap-${randomUUID()}`;

  async function fixture(role: CrmRole): Promise<Member> {
    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    await pool.query('INSERT INTO public.identity_users(user_id,display_name) VALUES($1,$2)', [id, `${source} ${role}`]);
    await pool.query("INSERT INTO public.identity_product_grants(user_id,product_id,role) VALUES($1,'crm',$2)", [id, role]);
    await pool.query("INSERT INTO public.identity_product_access(user_id,product_id,scope,capabilities) VALUES($1,'crm','own',$2)", [id, JSON.stringify(capabilitiesFor([role]))]);
    await pool.query("INSERT INTO public.identity_sessions(token_hash,user_id,security_revision,expires_at,client) VALUES($1,$2,1,now()+$3*interval '1 second','api')", [tokenAdapter.hash(token), id, SESSION_SECONDS]);
    return { id, token };
  }

  function importSameEmail(member: Member, customerKey: string) {
    return leads.importRows(member.token, {
      source,
      sourceDetail: source,
      kind: 'personal',
      idempotencyKey: randomUUID(),
      rows: [{ customerKey, companyName: `${source} COMPANY`, email: `${source}@example.invalid`, name: 'Synthetic Buyer' }],
    });
  }

  beforeAll(async () => {
    pool = new Pool(readTestDatabaseConfig());
    unwrap(await new PostgresCrmRepository(pool, log).migrate());
    unwrap(await new PostgresAuthRepository(pool, log).migrate());
    const leadRepo = new PostgresLeadRepository(pool, log);
    unwrap(await leadRepo.migrate());
    unwrap(await leadRepo.migrateLeadMatch());
    const client = await pool.connect();
    try { unwrap(await migrateLeadOverlapSchema(client)); } finally { client.release(); }
    const opportunityRepo = new PostgresOpportunityRepository(pool, log);
    unwrap(await opportunityRepo.migrate());
    notifications = new PostgresNotificationRepository(pool, log);
    unwrap(await notifications.migrate());
    leads = createLeadService(leadRepo, tokenAdapter);
    opportunities = createOpportunityService(opportunityRepo, tokenAdapter);
    userA = await fixture('sales');
    userB = await fixture('sales');
  }, TIMEOUT);

  afterAll(async () => { await pool?.end(); });

  it('allows the same email in two personal scopes, records one overlap, and notifies the other owner once on closed_won', async () => {
    const customerKey = `${source}-shared-company`;
    const first = unwrap(await importSameEmail(userA, customerKey));
    const second = unwrap(await importSameEmail(userB, customerKey));
    expect(first.rows[0]?.status).toBe('created');
    expect(second.rows[0]?.status).toBe('created');
    expect(second.rows[0]?.overlapCount).toBeGreaterThan(0);

    const overlaps = await pool.query('SELECT overlap_id FROM crm_lead_overlaps WHERE source_customer_id=$1 OR target_customer_id=$1 OR source_customer_id=$2 OR target_customer_id=$2', [first.rows[0]!.customerId, second.rows[0]!.customerId]);
    expect(overlaps.rows.length).toBeGreaterThan(0);

    const created = unwrap(await opportunities.create(userA.token, {
      customerId: first.rows[0]!.customerId!, expectedCustomerVersion: 1, idempotencyKey: randomUUID(),
      title: 'Synthetic won deal', source: 'synthetic',
    }));
    const won = unwrap(await opportunities.updateStage(userA.token, {
      opportunityId: created.opportunityId, expectedVersion: created.version, idempotencyKey: randomUUID(),
      stage: 'closed_won', amount: '1000', currency: 'USD', evidence: 'synthetic acceptance',
    }));
    expect(won.stage).toBe('closed_won');

    const notices = await pool.query('SELECT recipient_user_id,status FROM crm_deal_overlap_notices WHERE opportunity_id=$1', [created.opportunityId]);
    expect(notices.rows).toEqual([{ recipient_user_id: userB.id, status: 'pending' }]);
    const outbox = await pool.query('SELECT recipient_user_ids FROM public.identity_outbox WHERE event_type=$1 AND payload->>$2=$3', [DEAL_OVERLAP_EVENT, 'opportunityId', created.opportunityId]);
    expect(outbox.rows).toEqual([{ recipient_user_ids: [userB.id] }]);
    unwrap(await notifications.dispatch());
    const feed = unwrap(await notifications.feed(tokenAdapter.hash(userB.token), { deviceId: 'overlap-test', after: '0', limit: 100 }));
    expect(feed.items.filter(item => item.eventType === DEAL_OVERLAP_EVENT)).toHaveLength(1);
    await opportunities.updateStage(userA.token, {
      opportunityId: created.opportunityId, expectedVersion: won.version, idempotencyKey: randomUUID(),
      stage: 'closed_won', amount: '1000', currency: 'USD', evidence: 'synthetic acceptance',
    });
    expect((await pool.query('SELECT 1 FROM crm_deal_overlap_notices WHERE opportunity_id=$1', [created.opportunityId])).rows).toHaveLength(1);
  }, TIMEOUT);
});
