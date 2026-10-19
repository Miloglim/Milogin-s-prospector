import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { readTestDatabaseConfig } from '../../server/adapters/postgres/config';
import { recordContactMailEventIn } from '../../server/adapters/postgres/contact-mail-repository';
import { contactDetailIn } from '../../server/adapters/postgres/contact-assignment-repository';
import { capabilitiesFor } from '../../server/core/admin';
import type { ContactMailEventInput } from '../../server/core/contact-mail';
import type { LeadActor } from '../../server/adapters/postgres/lead-repository';
import { PostgresLeadRepository } from '../../server/adapters/postgres/lead-repository';
import type { Result } from '../../server/core/crm';
import { CONTACT_MAIL_SEND_STAGE_VERSION } from '../../server/adapters/postgres/contact-mail-schema';
function unwrap<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code); return result.data; }

describe.runIf(process.env.PROSPECTOR_PG_INTEGRATION === '1')('confirmed center send round PostgreSQL outer rollback', () => {
  it('advances once from current locked round, keeps reply/classification and rolls back every effect on outbox failure', async () => {
    const pool = new Pool(readTestDatabaseConfig()), client = await pool.connect();
    const counts = async () => (await client.query('SELECT (SELECT count(*) FROM identity.users) AS users,(SELECT count(*) FROM contacts) AS contacts,(SELECT count(*) FROM companies) AS companies,(SELECT count(*) FROM crm_contact_mail_events) AS events,(SELECT count(*) FROM crm_shared_activities) AS activities,(SELECT count(*) FROM identity.outbox) AS outbox,(SELECT count(*) FROM crm_schema_migrations) AS migrations')).rows[0];
    const before = await counts();
    await client.query('BEGIN');
    try {
      const facade = { options: pool.options, connect: async () => ({
        query: (sql: string, args?: unknown[]) => client.query(sql === 'BEGIN' ? 'SAVEPOINT n4_repository' : sql === 'COMMIT' ? 'RELEASE SAVEPOINT n4_repository' : sql === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT n4_repository' : sql, args), release: () => {},
      }) } as unknown as Pool;
      const repo = new PostgresLeadRepository(facade, { write: () => {} });
      unwrap(await repo.migrate());
      unwrap(await repo.migrate());
      expect((await client.query('SELECT count(*)::int AS n FROM crm_schema_migrations WHERE version=$1', [CONTACT_MAIL_SEND_STAGE_VERSION])).rows[0].n).toBe(1);
      const fixed = (await client.query("SELECT user_id FROM identity.users WHERE display_name='Agent 测试用户' AND active=true")).rows[0];
      expect(fixed).toBeDefined();
      const actor: LeadActor = { userId: fixed.user_id, roles: ['sales'], capabilities: capabilitiesFor(['sales']), scope: 'own' };
      const companyId = (await client.query("INSERT INTO companies(name) VALUES('N4 rollback send stage') RETURNING id")).rows[0].id;
      const customerId = randomUUID();
      await client.query("INSERT INTO crm_customers(customer_id,company_id,source,customer_key,source_detail,created_by,origin,owner_user_id,state) VALUES($1,$2,'rollback',$1::uuid::text,'N4 fixture',$3,'personal',$3,'owned')", [customerId, companyId, actor.userId]);
      const contactId = (await client.query("INSERT INTO contacts(email,company_id,stage,crm_touch_status) VALUES('contact@example.invalid',$1,'cold','replied') RETURNING id", [companyId])).rows[0].id;
      await client.query('INSERT INTO crm_customer_contacts(customer_id,contact_id) VALUES($1,$2)', [customerId, contactId]);
      await client.query("INSERT INTO crm_shared_activities(customer_id,actor_id,note,stage,method,contact_id,occurred_at) VALUES($1,$2,'classification','trial','note',$3,'2018-01-01T00:00:00Z')", [customerId, actor.userId, contactId]);
      const input: ContactMailEventInput = { contactId, customerId, eventKey: randomUUID(), mailboxKey: 'rollback', messageKey: '<accepted>', kind: 'sent', direction: 'outbound', occurredAt: '2020-01-01T00:00:00.000Z', subject: 'accepted', preview: '', fromEmail: 'sales@example.invalid', toEmails: ['contact@example.invalid'], ccEmails: [], advanceSendStage: true };
      const first = unwrap(await recordContactMailEventIn(client, actor, input));
      expect(first.contact).toMatchObject({ stage: 'f1', touchStatus: 'replied', relationshipStage: 'trial', contactVersion: 2 });
      expect((await client.query('SELECT stage FROM contacts WHERE id=$1', [contactId])).rows[0].stage).toBe(first.contact.stage);
      const eventCounts = await counts();
      const replay = unwrap(await recordContactMailEventIn(client, actor, input));
      expect(replay).toMatchObject({ duplicate: true, eventId: first.eventId, contact: { stage: 'f1', contactVersion: 2 } });
      expect(await counts()).toEqual(eventCounts);
      expect(unwrap(await recordContactMailEventIn(client, actor, { ...input, advanceSendStage: false })).duplicate).toBe(true);
      expect(await recordContactMailEventIn(client, actor, { ...input, subject: 'different', advanceSendStage: false })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      for (const stage of ['f2', 'f3', 'f4', 'f4']) {
        const receipt = unwrap(await recordContactMailEventIn(client, actor, { ...input, eventKey: randomUUID(), occurredAt: '2019-01-01T00:00:00.000Z' }));
        expect(receipt.contact).toMatchObject({ stage, touchStatus: 'replied', relationshipStage: 'trial' });
      }
      for (const fields of [{ toEmails: ['other@example.invalid'], ccEmails: input.toEmails }, { fromEmail: 'contact@example.invalid' }, { kind: 'replied' as const, direction: 'inbound' as const }]) {
        const unchanged = await counts();
        expect(await recordContactMailEventIn(client, actor, { ...input, ...fields, eventKey: randomUUID() })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await counts()).toEqual(unchanged);
      }
      // No flag and explicit false keep the legacy digest and do not advance a round.
      await client.query("UPDATE contacts SET stage='f2' WHERE id=$1", [contactId]);
      const { advanceSendStage: _flag, ...legacy } = input;
      const oldInput = { ...legacy, eventKey: randomUUID() };
      const old = unwrap(await recordContactMailEventIn(client, actor, oldInput));
      expect(old.contact.stage).toBe('f2');
      expect(unwrap(await recordContactMailEventIn(client, actor, { ...oldInput, advanceSendStage: false }))).toMatchObject({ duplicate: true, eventId: old.eventId });
      const beforeUpgrade = await counts();
      const upgraded = unwrap(await recordContactMailEventIn(client, actor, { ...oldInput, advanceSendStage: true }));
      expect(upgraded).toMatchObject({ duplicate: true, eventId: old.eventId, contact: { stage: 'f3', contactVersion: old.contact.contactVersion! + 1 } });
      const afterUpgrade = await counts();
      expect(afterUpgrade).toMatchObject({ events: beforeUpgrade.events, activities: beforeUpgrade.activities });
      expect(Number(afterUpgrade.outbox)).toBe(Number(beforeUpgrade.outbox) + 1);
      expect((await client.query("SELECT count(*)::int AS n FROM identity.outbox WHERE payload->>'mailEventId'=$1", [old.eventId])).rows[0].n).toBe(2);
      expect(unwrap(await recordContactMailEventIn(client, actor, { ...oldInput, advanceSendStage: true })).contact.stage).toBe('f3');
      expect(await counts()).toEqual(afterUpgrade);
      // Replay returns the current version, never the historical receipt version.
      expect(unwrap(await recordContactMailEventIn(client, actor, input)).contact).toMatchObject({ stage: 'f3', contactVersion: upgraded.contact.contactVersion });
      const upgradeFailureInput = { ...legacy, eventKey: randomUUID() };
      const upgradeFailure = unwrap(await recordContactMailEventIn(client, actor, upgradeFailureInput));
      const snapshot = unwrap(await contactDetailIn(client, actor, input));
      const snapshotCounts = await counts();
      await client.query("CREATE FUNCTION pg_temp.n4_mail_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'N4 outbox rollback'; END $$");
      await client.query("CREATE TRIGGER n4_mail_outbox_fail BEFORE INSERT ON identity.outbox FOR EACH ROW WHEN (NEW.event_type='crm.contact.followup') EXECUTE FUNCTION pg_temp.n4_mail_fail()");
      await client.query('SAVEPOINT n4_atomic');
      await expect(recordContactMailEventIn(client, actor, { ...input, eventKey: randomUUID() })).rejects.toThrow('N4 outbox rollback');
      await client.query('ROLLBACK TO SAVEPOINT n4_atomic');
      expect(await counts()).toEqual(snapshotCounts);
      expect(unwrap(await contactDetailIn(client, actor, input))).toEqual(snapshot);
      await expect(recordContactMailEventIn(client, actor, { ...upgradeFailureInput, advanceSendStage: true })).rejects.toThrow('N4 outbox rollback');
      await client.query('ROLLBACK TO SAVEPOINT n4_atomic');
      expect(await counts()).toEqual(snapshotCounts);
      expect(unwrap(await contactDetailIn(client, actor, input))).toEqual(snapshot);
      expect((await client.query('SELECT send_stage_advanced FROM crm_contact_mail_events WHERE event_id=$1', [upgradeFailure.eventId])).rows[0].send_stage_advanced).toBe(false);
      expect((await client.query("SELECT count(*)::int AS n FROM identity.outbox WHERE payload->>'mailEventId'=$1", [first.eventId])).rows[0].n).toBe(1);
    } finally {
      await client.query('ROLLBACK');
      expect(await counts()).toEqual(before);
      client.release(); await pool.end();
    }
  });
});
