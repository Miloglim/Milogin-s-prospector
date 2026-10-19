import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { readTestDatabaseConfig } from '../../server/adapters/postgres/config';
import { PostgresLeadRepository } from '../../server/adapters/postgres/lead-repository';
import { capabilitiesFor } from '../../server/core/admin';
import { tokenAdapter } from '../../server/adapters/password';
import type { ContactMailRepository } from '../../server/core/contact-mail';
import { legacyMailEventInput } from '../../src/main/core/legacy-mail-sync';
import type { Result } from '../../server/core/crm';

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
}

describe.runIf(process.env.PROSPECTOR_PG_INTEGRATION === '1')('legacy mail sync center contract', () => {
  it('accepts one converted legacy event once and deduplicates a replay', async () => {
    const pool = new Pool(readTestDatabaseConfig());
    const client = await pool.connect();
    const counts = async () => (await client.query(`
      SELECT
        (SELECT count(*) FROM crm_contact_mail_events) AS mail_events,
        (SELECT count(*) FROM crm_shared_activities) AS activities
    `)).rows[0];
    const before = await counts();
    await client.query('BEGIN');
    try {
      let lease = Promise.resolve();
      const facade = {
        options: pool.options,
        connect: async () => {
          const old = lease;
          let release!: () => void;
          lease = new Promise<void>(resolve => { release = resolve; });
          await old;
          return {
            query: (sql: string, args?: unknown[]) => client.query(
              sql === 'BEGIN' ? 'SAVEPOINT legacy_mail_test' :
              sql === 'COMMIT' ? 'RELEASE SAVEPOINT legacy_mail_test' :
              sql === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT legacy_mail_test' : sql,
              args,
            ),
            release,
          };
        },
      } as unknown as Pool;
      const repo = new PostgresLeadRepository(facade, { write: () => {} });
      const mail = repo as unknown as ContactMailRepository;
      unwrap(await repo.migrate());

      const actorId = randomUUID();
      const token = randomBytes(32).toString('base64url');
      const hash = tokenAdapter.hash(token);
      await client.query('INSERT INTO identity.users(user_id,display_name) VALUES($1,$2)', [actorId, 'legacy-mail-sync-fixture']);
      await client.query("INSERT INTO identity.product_grants(user_id,product_id,role) VALUES($1,'crm','sales')", [actorId]);
      await client.query("INSERT INTO identity.product_access(user_id,product_id,scope,capabilities) VALUES($1,'crm','own',$2)", [actorId, JSON.stringify(capabilitiesFor(['sales']))]);
      await client.query("INSERT INTO identity.sessions(token_hash,user_id,security_revision,expires_at,client) VALUES($1,$2,1,now()+interval '1 hour','api')", [hash, actorId]);

      const companyId = (await client.query("INSERT INTO companies(name) VALUES('legacy-mail-sync-company') RETURNING id")).rows[0].id;
      const customerId = randomUUID();
      await client.query("INSERT INTO crm_customers(customer_id,company_id,source,customer_key,source_detail,created_by,origin,state,owner_user_id) VALUES($1,$2,'legacy-fixture',$3,'legacy sync fixture',$4,'personal','owned',$4)", [customerId, companyId, customerId, actorId]);
      const centerContactId = (await client.query("INSERT INTO contacts(email,first_name,company_id) VALUES('legacy-contact@example.invalid','Legacy',$1) RETURNING id", [companyId])).rows[0].id;
      await client.query('INSERT INTO crm_customer_contacts(customer_id,contact_id) VALUES($1,$2)', [customerId, centerContactId]);

      const event = legacyMailEventInput({
        localEventId: 17,
        source: 'interaction',
        localContactId: 3,
        centerContactId,
        centerCustomerId: customerId,
        kind: 'sent',
        direction: 'outbound',
        occurredAt: '2026-01-02T00:00:00.000Z',
        subject: 'Legacy event subject',
        preview: 'Legacy event preview',
        mailboxKey: 'legacy-mailbox',
        messageKey: '<legacy-event-17>',
        fromEmail: 'sales@example.invalid',
        toEmails: ['legacy-contact@example.invalid'],
        ccEmails: [],
      });
      expect(JSON.stringify(event)).not.toContain('rawBody');

      const first = unwrap(await mail.recordContactMailEvent(hash, event));
      expect(first).toMatchObject({ duplicate: false, event: { subject: event.subject, preview: event.preview, actorId } });
      expect(first.event.activityId).not.toBeNull();
      const replay = unwrap(await mail.recordContactMailEvent(hash, event));
      expect(replay).toMatchObject({ duplicate: true, eventId: first.eventId });
      expect((await client.query('SELECT count(*)::int AS n FROM crm_contact_mail_events WHERE event_key=$1', [event.eventKey])).rows[0].n).toBe(1);
      expect((await client.query('SELECT count(*)::int AS n FROM crm_shared_activities WHERE customer_id=$1', [customerId])).rows[0].n).toBe(1);
    } finally {
      await client.query('ROLLBACK');
      expect(await counts()).toEqual(before);
      client.release();
      await pool.end();
    }
  }, 30000);
});
