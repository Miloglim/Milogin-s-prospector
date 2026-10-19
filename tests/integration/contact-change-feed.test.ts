import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { readTestDatabaseConfig } from '../../server/adapters/postgres/config';
import { PostgresCrmRepository } from '../../server/adapters/postgres/repository';
import { PostgresAuthRepository } from '../../server/adapters/postgres/auth-repository';
import { PostgresLeadRepository } from '../../server/adapters/postgres/lead-repository';
import { PostgresNotificationRepository } from '../../server/adapters/postgres/notification-repository';
import { PostgresContactChangeRepository } from '../../server/adapters/postgres/contact-change-repository';
import { tokenAdapter } from '../../server/adapters/password';

describe.runIf(process.env.PROSPECTOR_PG_INTEGRATION === '1')('contact change feed N6', () => {
  const log = { write: () => {} }, admin = randomUUID(), sales = randomUUID(), key = randomUUID();
  let pool: Pool, feed: PostgresContactChangeRepository, token: string, contactId: number, customerId: string;
  beforeAll(async () => {
    pool = new Pool(readTestDatabaseConfig());
    expect((await new PostgresCrmRepository(pool, log).migrate()).ok).toBe(true);
    expect((await new PostgresAuthRepository(pool, log).migrate()).ok).toBe(true);
    expect((await new PostgresLeadRepository(pool, log).migrate()).ok).toBe(true);
    expect((await new PostgresNotificationRepository(pool, log).migrate()).ok).toBe(true);
    feed = new PostgresContactChangeRepository(pool, log); expect((await feed.migrate()).ok).toBe(true);
    for (const [user, role, scope] of [[admin, 'admin', 'shared'], [sales, 'sales', 'own']]) {
      await pool.query('INSERT INTO identity.users(user_id,display_name) VALUES($1,$2)', [user, 'n6 synthetic']);
      await pool.query("INSERT INTO identity.product_grants(user_id,product_id,role) VALUES($1,'crm',$2)", [user, role]);
      await pool.query("INSERT INTO identity.product_access(user_id,product_id,scope) VALUES($1,'crm',$2)", [user, scope]);
    }
    token = randomBytes(32).toString('base64url'); await pool.query("INSERT INTO identity.sessions(token_hash,user_id,security_revision,expires_at,client) VALUES($1,$2,1,now()+interval '1 hour','api')", [tokenAdapter.hash(token), admin]);
    const company = await pool.query('INSERT INTO companies(name) VALUES($1) RETURNING id', [`n6 ${key}`]);
    const customer = await pool.query("INSERT INTO crm_customers(company_id,source,customer_key,source_detail,state,created_by) VALUES($1,'n6',$2,'test','published',$3) RETURNING customer_id", [company.rows[0].id, key, admin]); customerId = customer.rows[0].customer_id;
    const contact = await pool.query("INSERT INTO contacts(email,company_id,first_name) VALUES($1,$2,'N6') RETURNING id", [`n6-${key}@example.invalid`, company.rows[0].id]); contactId = contact.rows[0].id;
    await pool.query('INSERT INTO crm_customer_contacts(customer_id,contact_id) VALUES($1,$2)', [customerId, contactId]);
  }, 30000);
  afterAll(async () => { await pool?.end(); });
  it('orders cursor, includes admins, and hides snapshots after deletion', async () => {
    await pool.query("INSERT INTO identity.outbox(event_type,user_id,product_id,revision,customer_id,payload,recipient_user_ids) VALUES('crm.contact.updated',$1,'crm',2,$2,$3,$4)", [sales, customerId, JSON.stringify({ contactId, customerId, version: 2 }), [sales]]);
    const first = await feed.feed(tokenAdapter.hash(token), { after: '0', limit: 10 }); expect(first.ok).toBe(true); if (!first.ok) return;
    expect(first.data.items[0]).toMatchObject({ contactId, kind: 'upsert' });
    await pool.query('UPDATE contacts SET crm_deleted_at=now(),crm_contact_version=3 WHERE id=$1', [contactId]);
    await pool.query("INSERT INTO identity.outbox(event_type,user_id,product_id,revision,customer_id,payload,recipient_user_ids) VALUES('crm.contact.deleted',$1,'crm',3,$2,$3,$4)", [sales, customerId, JSON.stringify({ contactId, customerId, version: 3 }), [sales]]);
    const second = await feed.feed(tokenAdapter.hash(token), { after: first.data.nextCursor, limit: 10 }); expect(second.ok).toBe(true); if (!second.ok) return;
    expect(second.data.items[0]).toMatchObject({ contactId, kind: 'tombstone' }); expect(BigInt(second.data.nextCursor)).toBeGreaterThan(BigInt(first.data.nextCursor));
  });
});
