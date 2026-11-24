import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { readTestDatabaseConfig } from '../../server/adapters/postgres/config';
import { PostgresLeadRepository } from '../../server/adapters/postgres/lead-repository';
import { PostgresCustomerStatusRepository } from '../../server/adapters/postgres/customer-status-repository';
import { backfillCustomerStatuses } from '../../server/adapters/postgres/customer-status-backfill';
import { capabilitiesFor } from '../../server/core/admin';
import { tokenAdapter } from '../../server/adapters/password';
import type { Result } from '../../server/core/crm';

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
}

describe.runIf(process.env.PROSPECTOR_PG_INTEGRATION === '1')('customer status historical backfill', () => {
  it('dry-runs, applies idempotently and preserves a manual lock', async () => {
    const pool = new Pool(readTestDatabaseConfig()), client = await pool.connect();
    await client.query('BEGIN');
    try {
      const facade = { options: pool.options, connect: async () => ({ query: (sql: string, args?: unknown[]) => client.query(sql === 'BEGIN' ? 'SAVEPOINT backfill_test' : sql === 'COMMIT' ? 'RELEASE SAVEPOINT backfill_test' : sql === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT backfill_test' : sql, args), release: () => {} }) } as unknown as Pool;
      const leads = new PostgresLeadRepository(facade, { write: () => {} });
      const status = new PostgresCustomerStatusRepository(facade, { write: () => {} });
      unwrap(await leads.migrate());

      const userId = randomUUID(), token = randomBytes(32).toString('base64url'), hash = tokenAdapter.hash(token);
      await client.query('INSERT INTO public.identity_users(user_id,display_name) VALUES($1,$2)', [userId, 'backfill-user']);
      await client.query("INSERT INTO public.identity_product_grants(user_id,product_id,role) VALUES($1,'crm','sales')", [userId]);
      await client.query("INSERT INTO public.identity_product_access(user_id,product_id,scope,capabilities) VALUES($1,'crm','own',$2)", [userId, JSON.stringify(['leads.read', 'leads.develop'])]);
      await client.query("INSERT INTO public.identity_sessions(token_hash,user_id,security_revision,expires_at,client) VALUES($1,$2,1,now()+interval '1 hour','api')", [hash, userId]);

      async function fixture(label: string, stage = 'cold') {
        const companyId = Number((await client.query('INSERT INTO companies(name) VALUES($1) RETURNING id', [label])).rows[0].id);
        const customerId = String((await client.query("INSERT INTO crm_customers(company_id,source,customer_key,source_detail,state,owner_user_id,created_by,origin,relationship_stage) VALUES($1,'backfill',$2,'synthetic','owned',$3,$3,'personal',$4) RETURNING customer_id", [companyId, randomUUID(), userId, stage])).rows[0].customer_id);
        const contactId = Number((await client.query("INSERT INTO contacts(email,first_name,company_id,crm_touch_status) VALUES($1,$2,$3,'uncontacted') RETURNING id", [`${randomUUID()}@backfill.invalid`, label, companyId])).rows[0].id);
        await client.query('INSERT INTO crm_customer_contacts(customer_id,contact_id) VALUES($1,$2)', [customerId, contactId]);
        return { customerId, contactId };
      }

      const normal = await fixture('Backfill Normal', 'cooperating');
      await client.query("INSERT INTO crm_shared_activities(customer_id,actor_id,note,stage,method,occurred_at,recorded_at,created_at,contact_id) VALUES($1,$2,'quoted','quoting','phone','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',$3)", [normal.customerId, userId, normal.contactId]);
      await client.query("INSERT INTO crm_shared_activities(customer_id,actor_id,note,contact_status,method,occurred_at,recorded_at,created_at,contact_id) VALUES($1,$2,'replied','replied','email','2026-01-02T00:00:00Z','2026-01-02T00:00:00Z','2026-01-02T00:00:00Z',$3)", [normal.customerId, userId, normal.contactId]);
      const dry = unwrap(await backfillCustomerStatuses(facade, { apply: false, customerIds: [normal.customerId] }));
      expect(dry).toMatchObject({ customers: 1, plannedEvents: 2, insertedEvents: 0 });
      const applied = unwrap(await backfillCustomerStatuses(facade, { apply: true, customerIds: [normal.customerId] }));
      expect(applied.insertedEvents).toBe(2);
      expect((await client.query('SELECT status FROM crm_customer_status_state WHERE customer_id=$1', [normal.customerId])).rows[0].status).toBe('won');
      const again = unwrap(await backfillCustomerStatuses(facade, { apply: true, customerIds: [normal.customerId] }));
      expect(again.insertedEvents).toBe(0);

      const locked = await fixture('Backfill Locked');
      const lockedState = unwrap(await status.correct(hash, { customerId: locked.customerId, contactId: locked.contactId, expectedVersion: 0, status: 'negotiating', reason: '人工锁定', idempotencyKey: randomUUID() }));
      await client.query("INSERT INTO crm_shared_activities(customer_id,actor_id,note,stage,method,occurred_at,recorded_at,created_at,contact_id) VALUES($1,$2,'cooperating','cooperating','phone','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z',$3)", [locked.customerId, userId, locked.contactId]);
      const lockedResult = unwrap(await backfillCustomerStatuses(facade, { apply: true, customerIds: [locked.customerId] }));
      expect(lockedResult.lockedCustomers).toBe(1);
      expect((await client.query('SELECT status,manual_locked AS "manualLocked",version FROM crm_customer_status_state WHERE customer_id=$1', [locked.customerId])).rows[0]).toMatchObject({ status: 'negotiating', manualLocked: true, version: lockedState.version });
      expect((await client.query("SELECT status FROM crm_customer_status_events WHERE customer_id=$1 AND source='import' ORDER BY occurred_at DESC LIMIT 1", [locked.customerId])).rows[0].status).toBe('won');
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await pool.end();
    }
  }, 30000);
});
