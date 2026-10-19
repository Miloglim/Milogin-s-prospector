import { describe, it, expect } from 'vitest';
import { Pool } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readTestDatabaseConfig } from '../../server/adapters/postgres/config';
import { PostgresLeadRepository } from '../../server/adapters/postgres/lead-repository';
import { createLeadService } from '../../server/services/leads';
import { createCrmHandler } from '../../server/transport/crm-http';
import { capabilitiesFor } from '../../server/core/admin';
import { tokenAdapter } from '../../server/adapters/password';
import { centerContactPath, type CenterContactQuery } from '../../server/core/center-contacts';
import type { CrmRole } from '../../server/core/auth';
import type { Result } from '../../server/core/crm';
import { createOnlineCrmService } from '../../src/main/services/online-crm.service';
import { readCenterContacts } from '../../src/renderer/hooks/useCenterContacts';
import { contactMirrorPage } from '../../src/main/core/contact-mirror';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';

function unwrap<T>(r: Result<T>): T { if (!r.ok) throw Error(`${r.error.code}: ${r.error.message}`); return r.data; }
const CAPACITY_TEST_TIMEOUT_MS = 120000;
describe.runIf(process.env.PROSPECTOR_PG_INTEGRATION === '1' && process.env.PROSPECTOR_CAPACITY_REPORT !== undefined)('isolated center capacity evidence', () => {
  it('measures authorized pages over 100000 rollback-only contacts', async () => {
    const CONTACT_COUNT = 100000, PAGE_SIZE = 50, SAMPLE_COUNT = 5;
    const samples: Record<string, number[]> = {};
    const plans: Record<string, unknown> = {};
    const projectionLoops: Record<string, number> = {};
    let pageQuery: { sql: string; args?: unknown[] } | undefined;
    const pool = new Pool(readTestDatabaseConfig()), client = await pool.connect();
    const before = (await client.query('SELECT count(*)::int AS count FROM contacts')).rows[0].count;
    await client.query('BEGIN');
    try {
      const user = randomUUID(), customer = randomUUID(), token = randomBytes(32).toString('base64url');
      await client.query("INSERT INTO identity.users(user_id,display_name) VALUES($1,'Capacity fixture')", [user]);
      await client.query("INSERT INTO identity.product_grants(user_id,product_id,role) VALUES($1,'crm','sales')", [user]);
      await client.query("INSERT INTO identity.product_access(user_id,product_id,scope,capabilities) VALUES($1,'crm','own',$2)", [user, JSON.stringify(capabilitiesFor(['sales']))]);
      await client.query("INSERT INTO identity.sessions(token_hash,user_id,security_revision,expires_at,client) VALUES($1,$2,1,now()+interval '1 hour','api')", [tokenAdapter.hash(token), user]);
      const company = (await client.query("INSERT INTO companies(name) VALUES('Synthetic capacity company') RETURNING id")).rows[0].id;
      await client.query("INSERT INTO crm_customers(customer_id,company_id,source,source_detail,customer_key,created_by,owner_user_id,origin,state) VALUES($1,$2,'capacity','synthetic rollback fixture',$1::uuid::text,$3,$3,'personal','owned')", [customer, company, user]);
      await client.query(`WITH inserted AS (
        INSERT INTO contacts(company_id,email,first_name,country,source)
        SELECT $1, 'capacity-' || n || '@example.invalid', 'Contact ' || n, 'Mexico', 'capacity'
        FROM generate_series(1,$2::int) n RETURNING id
      ) INSERT INTO crm_customer_contacts(customer_id,contact_id) SELECT $3,id FROM inserted`, [company, CONTACT_COUNT, customer]);
      await client.query('ANALYZE contacts');
      await client.query('ANALYZE crm_customer_contacts');
      const facade = { options: pool.options, connect: async () => ({ query: (sql: string, args?: unknown[]) => {
        if (sql.includes('AS "contactId"') && sql.includes('LIMIT $17')) pageQuery = { sql, args };
        return client.query(sql === 'BEGIN' ? 'SAVEPOINT capacity_read' : sql === 'COMMIT' ? 'RELEASE SAVEPOINT capacity_read' : sql === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT capacity_read' : sql, args);
      }, release: () => {} }) } as unknown as Pool;
      const service = createLeadService(new PostgresLeadRepository(facade, { write: () => {} }), tokenAdapter);
      for (const [name, query] of Object.entries({ first: { limit: PAGE_SIZE, offset: 0 }, last: { limit: PAGE_SIZE, offset: CONTACT_COUNT - PAGE_SIZE }, search: { limit: PAGE_SIZE, offset: 0, search: 'capacity-' } })) {
        samples[name] = [];
        for (let iteration = 0; iteration < SAMPLE_COUNT; iteration++) {
          const started = performance.now();
          const page = unwrap(await service.contacts(token, query));
          samples[name].push(Math.round((performance.now() - started) * 100) / 100);
          expect(page.total).toBe(CONTACT_COUNT);
          expect(page.items).toHaveLength(PAGE_SIZE);
          expect(page.items.every(row => row.customerId === customer && row.ownerUserId === user)).toBe(true);
        }
        expect(pageQuery).toBeDefined();
        const plan = (await client.query(`EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) ${pageQuery!.sql}`, pageQuery!.args)).rows[0]['QUERY PLAN'][0];
        plans[name] = plan;
        const noteLoops: number[] = [];
        function visit(node: Record<string, any>): void {
          if (node['Node Type'] === 'Limit' && node['Parent Relationship'] === 'SubPlan' && node.Output?.[0]?.endsWith('.note')) noteLoops.push(node['Actual Loops']);
          for (const child of node.Plans ?? []) visit(child);
        }
        visit(plan.Plan);
        expect(noteLoops.length).toBeGreaterThan(0);
        projectionLoops[name] = Math.max(...noteLoops);
      }
    } finally {
      await client.query('ROLLBACK');
      try { expect((await client.query('SELECT count(*)::int AS count FROM contacts')).rows[0].count).toBe(before); }
      finally { client.release(); await pool.end(); }
    }
    writeFileSync(process.env.PROSPECTOR_CAPACITY_REPORT!, JSON.stringify({ synthetic: true, contacts: CONTACT_COUNT, samples, projectionLoops, plans, transport: 'real service and PostgreSQL; no HTTP', rollbackVerified: true }, null, 2));
    // Deep offsets must not compute mail/activity display fields for skipped rows.
    expect(projectionLoops.last).toBeLessThanOrEqual(PAGE_SIZE);
  }, CAPACITY_TEST_TIMEOUT_MS);
});
describe.runIf(process.env.PROSPECTOR_PG_INTEGRATION === '1')('center contact list real PostgreSQL and HTTP', () => {
  it('returns all contact rows, applies permissions before pagination and preserves literal filters with complete rollback', async () => {
    const pool = new Pool(readTestDatabaseConfig());
    const client = await pool.connect();
    const counts = async () => (await client.query('SELECT (SELECT count(*) FROM identity.users) AS users,(SELECT count(*) FROM identity.sessions) AS sessions,(SELECT count(*) FROM companies) AS companies,(SELECT count(*) FROM contacts) AS contacts,(SELECT count(*) FROM crm_customers) AS customers,(SELECT count(*) FROM identity.outbox) AS events')).rows[0];
    const before = await counts();
    await client.query('BEGIN');
    try {
      const prefix = `center-read-${randomUUID()}`;
      async function actor(role: CrmRole, scope: 'own' | 'shared' = 'own') {
        const id = randomUUID(), token = randomBytes(32).toString('base64url');
        await client.query('INSERT INTO identity.users(user_id,display_name) VALUES($1,$2)', [id, `${prefix} ${role}`]);
        await client.query("INSERT INTO identity.product_grants(user_id,product_id,role) VALUES($1,'crm',$2)", [id, role]);
        await client.query("INSERT INTO identity.product_access(user_id,product_id,scope,capabilities) VALUES($1,'crm',$2,$3)", [id, scope, JSON.stringify(capabilitiesFor([role]))]);
        await client.query("INSERT INTO identity.sessions(token_hash,user_id,security_revision,expires_at,client) VALUES($1,$2,1,now()+interval '1 hour','api')", [tokenAdapter.hash(token), id]);
        return { id, token };
      }
      const user = await actor('sales'), other = await actor('sales'), manager = await actor('operations', 'shared'), admin = await actor('admin', 'shared');
      async function customer(createdBy: string, owner: string | null, origin: 'personal' | 'operations', suffix: string, count: number) {
        // Company country is authoritative even when a historical contact has a different value.
        const company = (await client.query('INSERT INTO companies(name,country) VALUES($1,$2) RETURNING id', [`${prefix} ${suffix}`, 'Brazil'])).rows[0];
        const customerId = randomUUID();
        await client.query('INSERT INTO crm_customers(customer_id,company_id,source,customer_key,source_detail,created_by,owner_user_id,origin,state) VALUES($1,$2,$3,$1::uuid::text,$4,$5,$6,$7,$8)', [customerId, company.id, prefix, 'rollback fixture', createdBy, owner, origin, owner ? 'owned' : 'draft']);
        const ids: number[] = [];
        for (let index = 0; index < count; index++) {
          const row = (await client.query(`INSERT INTO contacts(email,company_id,first_name,last_name,title,phone,linkedin,country,client_type,language,stage,status,tags,extra,assignee,source,source_detail,crm_touch_status,updated_at)
            VALUES($1,$2,'First','Last','Routing manager','123','https://example.invalid','Mexico','agent','PT','f2','replied',$3,$4,'old assignee',$5,'source file','contacted','2026-10-14T00:00:00Z') RETURNING id`, [index === 0 ? null : `${randomUUID()}@example.invalid`, company.id, JSON.stringify(['quoting']), JSON.stringify({ crmPreferences: { warnDays: 3 } }), prefix])).rows[0];
          ids.push(row.id);
          await client.query('INSERT INTO crm_customer_contacts(customer_id,contact_id) VALUES($1,$2)', [customerId, row.id]);
        }
        return { customerId, ids };
      }
      const mine = await customer(user.id, user.id, 'personal', '100%_literal', 3);
      await customer(other.id, other.id, 'personal', '100XXliteral hidden', 2);
      const assigned = await customer(manager.id, user.id, 'operations', 'assigned', 1);
      await customer(manager.id, null, 'operations', 'unassigned', 1);
      await customer(manager.id, null, 'operations', 'no contacts', 0);
      // Repositories use savepoints inside a fixture transaction, so all synthetic identities/data disappear.
      const facade = { options: pool.options, connect: async () => ({ query: (sql: string, args?: unknown[]) => client.query(sql === 'BEGIN' ? 'SAVEPOINT contact_read' : sql === 'COMMIT' ? 'RELEASE SAVEPOINT contact_read' : sql === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT contact_read' : sql, args), release: () => {} }) } as unknown as Pool;
      const service = createLeadService(new PostgresLeadRepository(facade, { write: () => {} }), tokenAdapter);
      const query: CenterContactQuery = { search: prefix, limit: 50, offset: 0 };
      const minePage = unwrap(await service.contacts(user.token, query));
      expect(minePage.total).toBe(4);
      expect(minePage.items.filter(row => row.customerId === mine.customerId)).toHaveLength(3);
      expect(minePage.items.find(row => row.customerId === assigned.customerId)?.origin).toBe('operations');
      expect(unwrap(await service.contacts(other.token, query)).total).toBe(2);
      expect(unwrap(await service.contacts(manager.token, query)).total).toBe(2);
      expect(unwrap(await service.contacts(admin.token, query)).total).toBe(7);
      const all = unwrap(await service.contacts(admin.token, { ...query, limit: 2 }));
      const next = unwrap(await service.contacts(admin.token, { ...query, limit: 2, offset: 2 }));
      expect(all.total).toBe(7);
      expect(next.total).toBe(7);
      expect(all.items.map(row => row.contactId).some(id => next.items.some(row => row.contactId === id))).toBe(false);
      expect(all.items[0]!.contactId).toBeGreaterThan(all.items[1]!.contactId);
      const literal = unwrap(await service.contacts(admin.token, { ...query, search: '100%_', stage: 'f2', status: 'replied', tags: 'quoting', clientType: 'agent', country: 'Brazil', language: 'PT', touchStatus: 'contacted' }));
      expect(literal.total).toBe(3);
      expect(literal.items.some(row => row.email === null)).toBe(true);
      expect(literal.items[0]).toMatchObject({ customerId: mine.customerId, firstName: 'First', lastName: 'Last', country: 'Brazil', language: 'PT', stage: 'f2', status: 'replied', touchStatus: 'contacted', tags: ['quoting'], extra: { crmPreferences: { warnDays: 3 } } });
      expect(unwrap(await service.contacts(user.token, { ...query, country: 'Mexico' })).total).toBe(0);
      expect(unwrap(await service.contacts(user.token, { ...query, stage: 'quoting' })).total).toBe(0);
      for (const account of [user, manager, admin]) {
        const authorized = unwrap(await service.contacts(account.token, query)).items;
        expect(authorized.every(row => row.assignmentStatus === null)).toBe(true);
        for (const filters of [{}, { limit: 2, offset: 1 }, { scope: 'personal' as const }, { scope: 'assigned' as const }, { assignment: 'accepted' as const }, { followupOnly: true, crmStage: 'reaching' as const }, { search: '100%_', stage: 'f2', status: 'replied', tags: 'quoting', clientType: 'agent', country: 'Brazil', language: 'PT', touchStatus: 'contacted' as const }]) {
          const filtered = { ...query, ...filters };
          expect(contactMirrorPage(authorized, filtered, account.id)).toEqual(unwrap(await service.contacts(account.token, filtered)));
        }
      }
      // Followup ordering is derived before paging, while each page keeps the matching note.
      await client.query(`INSERT INTO crm_shared_activities(customer_id,actor_id,note,method,occurred_at,contact_id,stage)
        VALUES($1,$2,'newest effective call','phone','2022-01-02T00:00:00Z',$3,'quoting'),
        ($1,$2,'older effective call','phone','2021-01-02T00:00:00Z',$4,'reaching'),
        ($1,$2,'annotation is not a followup','note','2023-01-02T00:00:00Z',$4,'quoting')`, [mine.customerId, user.id, mine.ids[0], mine.ids[2]]);
      const followupQuery = { ...query, search: '100%_', followupOnly: true, limit: 1 };
      const newest = unwrap(await service.contacts(user.token, followupQuery));
      expect(newest.total).toBe(3);
      expect(newest.items[0]).toMatchObject({ contactId: mine.ids[0], lastFollowupNote: 'newest effective call', lastFollowupAt: '2022-01-02T00:00:00.000Z' });
      expect(unwrap(await service.contacts(user.token, { ...followupQuery, offset: 1 })).items[0]).toMatchObject({ contactId: mine.ids[2], relationshipStage: 'quoting', lastFollowupNote: 'older effective call', lastFollowupAt: '2021-01-02T00:00:00.000Z' });
      expect(unwrap(await service.contacts(user.token, { ...followupQuery, offset: 2 })).items[0]).toMatchObject({ contactId: mine.ids[1], lastFollowupNote: null, lastFollowupAt: null });
      expect(unwrap(await service.contacts(user.token, { ...followupQuery, crmStage: 'quoting', offset: 1 })).items[0]?.contactId).toBe(mine.ids[2]);
      expect(unwrap(await service.contacts(user.token, { ...followupQuery, offset: 3 }))).toEqual({ items: [], total: 3 });
      expect(await service.contacts('', query)).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
      const handler = createCrmHandler(service);
      const server = createServer((request, response) => { void handler(request, response); });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const desktop = createOnlineCrmService({ request: async <T>(_method: string, path: string) => (await fetch(base + path, { headers: { Authorization: `Bearer ${user.token}` } })).json() as Promise<Result<T>>, login: async () => { throw Error('not used'); }, logout: async () => { throw Error('not used'); }, preview: async () => { throw Error('not used'); }, feed: async () => { throw Error('not used'); } });
        const rendered = unwrap(await readCenterContacts({ search: prefix }, async (_channel, input) => desktop.contacts(input)));
        expect(rendered.total).toBe(4);
        expect(rendered.items.every(row => row.rowKey === `${row.customerId}:${row.contactId}`)).toBe(true);
        expect(rendered.items.some(row => 'id' in row)).toBe(false);
        const response = await fetch(base + centerContactPath(query), { headers: { Authorization: `Bearer ${other.token}` } });
        expect(response.status).toBe(200);
        expect((await response.json()).data.total).toBe(2);
      } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
      await client.query('UPDATE identity.users SET active=false WHERE user_id=$1', [user.id]);
      expect(await service.contacts(user.token, query)).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
    } finally {
      await client.query('ROLLBACK');
      const after = await counts();
      client.release(); await pool.end();
      expect(after).toEqual(before);
    }
  }, 30000);
});
