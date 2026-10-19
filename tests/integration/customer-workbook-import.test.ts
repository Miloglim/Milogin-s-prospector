import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { Pool } from 'pg';
import { randomUUID, randomBytes } from 'node:crypto';
import { readTestDatabaseConfig } from '../../server/adapters/postgres/config';
import { PostgresCrmRepository } from '../../server/adapters/postgres/repository';
import { PostgresAuthRepository } from '../../server/adapters/postgres/auth-repository';
import { PostgresLeadRepository } from '../../server/adapters/postgres/lead-repository';
import { PostgresNotificationRepository } from '../../server/adapters/postgres/notification-repository';
import { capabilitiesFor } from '../../server/core/admin';
import { tokenAdapter } from '../../server/adapters/password';
import { createLeadService } from '../../server/services/leads';
import { createContactAssignmentService } from '../../server/services/contact-assignments';
import type { CrmRole } from '../../server/core/auth';
import type { Result } from '../../server/core/crm';
import type { WorkbookImportRequest, WorkbookImportRow } from '../../server/core/customer-import';
const TIMEOUT = 30000, SESSION_SECONDS = 3600;
const log = { write: () => {} };
function unwrap<T>(result: Result<T>): T { if (!result.ok) throw Error(`${result.error.code}: ${result.error.message}`); return result.data; }
let pool: Pool, service: ReturnType<typeof createLeadService>, ops: { id: string; token: string }, sales: { id: string; token: string }, otherOps: { id: string; token: string };
let contactActions: ReturnType<typeof createContactAssignmentService>;
const source = `b1-synthetic-${randomUUID()}`;
const row = (ref: string, fields: Partial<WorkbookImportRow> = {}): WorkbookImportRow => ({ entity: 'customer', sourceRef: ref, companyName: `Synthetic ${ref}`, sheetName: 'customers', rowNumber: 2, rawRow: { original: 'synthetic evidence' }, ...fields });
const input = (rows: WorkbookImportRow[], fields: Partial<WorkbookImportRequest> = {}): WorkbookImportRequest => ({ source, sourceDetail: 'synthetic workbook only', kind: 'operations', idempotencyKey: randomUUID(), rows, ...fields });
async function actor(role: CrmRole) {
 const id = randomUUID(), token = randomBytes(32).toString('base64url');
 await pool.query('INSERT INTO identity.users(user_id,display_name) VALUES($1,$2)', [id, `synthetic B1 ${role}`]);
 await pool.query("INSERT INTO identity.product_grants(user_id,product_id,role) VALUES($1,'crm',$2)", [id, role]);
 await pool.query("INSERT INTO identity.product_access(user_id,product_id,scope,capabilities) VALUES($1,'crm',$2,$3)", [id, role === 'operations' ? 'shared' : 'own', JSON.stringify(capabilitiesFor([role]))]);
 await pool.query("INSERT INTO identity.sessions(token_hash,user_id,security_revision,expires_at,client) VALUES($1,$2,1,now()+$3*interval '1 second','api')", [tokenAdapter.hash(token), id, SESSION_SECONDS]);
 return { id, token };
}
describe.runIf(process.env.PROSPECTOR_PG_INTEGRATION === '1')('B1 synthetic PostgreSQL workbook import', () => {
 beforeAll(async () => {
  pool = new Pool(readTestDatabaseConfig());
  unwrap(await new PostgresCrmRepository(pool, log).migrate()); unwrap(await new PostgresAuthRepository(pool, log).migrate());
  const repo = new PostgresLeadRepository(pool, log); unwrap(await repo.migrate());
  contactActions = createContactAssignmentService(repo, tokenAdapter);
  unwrap(await new PostgresNotificationRepository(pool, log).migrate());
  service = createLeadService(repo, tokenAdapter); ops = await actor('operations'); sales = await actor('sales'); otherOps = await actor('operations');
 }, TIMEOUT);
 afterAll(async () => { await pool?.end(); });
 it('creates no-contact customers, appends multiple contacts without requiring email and keeps exact evidence coordinates', async () => {
  const request = input([row('multi', { country: 'BR', businessType: '代理', sourceCreatedAt: '2020-01-02' }), row('none')]);
  const receipt = unwrap(await service.importWorkbook(ops.token, request)); expect(receipt.rows.map(x => x.status)).toEqual(['created', 'created']);
  expect(unwrap(await service.importWorkbook(ops.token, request))).toEqual(receipt);
  const id = receipt.rows[0]!.customerId!, emptyId = receipt.rows[1]!.customerId!;
  const contacts = input([row('phone-one', { entity: 'contact', customerRef: 'multi', email: '', name: 'Synthetic person', phone: 'synthetic phone', sheetName: 'contacts', rowNumber: 7 }), row('email-two', { entity: 'contact', customerRef: 'multi', email: `B1-${source}@example.invalid`, sheetName: 'contacts', rowNumber: 8 })]);
  const appended = unwrap(await service.importWorkbook(ops.token, contacts)); expect(appended.rows.map(x => x.status)).toEqual(['appended', 'appended']);
  const detail = unwrap(await service.detail(ops.token, id)); expect(detail.contacts).toHaveLength(2); expect(detail.contacts[0]!.email).toBe(''); expect(detail.contacts[1]!.email).toBe(`b1-${source}@example.invalid`); expect(detail.businessType).toBe('代理'); expect(detail.sourceCreatedAt).toBe('2020-01-02T00:00:00.000Z');
  const nullEmail = await pool.query('SELECT email FROM contacts WHERE id=$1', [detail.contacts[0]!.contactId]); expect(nullEmail.rows[0].email).toBeNull();
  expect(unwrap(await new PostgresCrmRepository(pool, log).getContact(detail.contacts[0]!.contactId)).email).toBe('');
  const raw = await pool.query('SELECT raw_row FROM crm_import_rows WHERE row_id=$1', [appended.rows[0]!.rowId]); expect(raw.rows[0].raw_row).toMatchObject({ entity: 'contact', sheetName: 'contacts', rowNumber: 7, rawRow: { original: 'synthetic evidence' } });
  const duplicate = unwrap(await service.importWorkbook(ops.token, { ...contacts, idempotencyKey: randomUUID() })); expect(duplicate.rows.map(x => x.status)).toEqual(['duplicate', 'duplicate']);
  expect(unwrap(await service.detail(ops.token, id)).version).toBe(detail.version);
  const empty = unwrap(await service.detail(ops.token, emptyId)); expect(empty.contacts).toEqual([]);
  // Empty companies are retained, but assignment requires an actual selected contact.
  expect(await contactActions.createAssignments(ops.token, { contacts: [], targetUserId: sales.id, notifyUserIds: [], idempotencyKey: randomUUID() })).toMatchObject({ error: { code: 'INVALID_INPUT' } });
  expect(await service.detail(sales.token, emptyId)).toMatchObject({ error: { code: 'NOT_FOUND' } });
  const ref = { customerId: id, contactId: detail.contacts[0]!.contactId };
  const pending = unwrap(await contactActions.createAssignments(ops.token, { contacts: [{ ...ref, expectedVersion: 1 }], targetUserId: sales.id, notifyUserIds: [], idempotencyKey: randomUUID() })).items[0]!;
  expect(await contactActions.contactDetail(sales.token, ref)).toMatchObject({ error: { code: 'NOT_FOUND' } });
  unwrap(await contactActions.decide(sales.token, 'accept', { requestId: pending.requestId, expectedVersion: pending.version, idempotencyKey: randomUUID() }));
  expect(unwrap(await contactActions.contactDetail(sales.token, ref)).contact.ownerUserId).toBe(sales.id);
  expect(await contactActions.contactDetail(sales.token, { customerId: id, contactId: detail.contacts[1]!.contactId })).toMatchObject({ error: { code: 'NOT_FOUND' } });
 });
 it('reports every semantic exception without importing an unmatched or conflicted contact', async () => {
  unwrap(await service.importWorkbook(ops.token,input([row('semantic'),row('semantic-phone',{entity:'contact',customerRef:'semantic',name:'Synthetic person',phone:'semantic phone'})])));
  const receipt = unwrap(await service.importWorkbook(ops.token, input([row('invalid', { companyName: '' }), row('missing', { entity: 'contact', customerRef: 'absent', name: 'Synthetic unmatched' }), row('semantic', { companyName: 'Renamed without confirmation' }), row('bad-email', { entity: 'contact', customerRef: 'semantic', email: 'bad email' })])));
  expect(receipt.rows.map(x => x.status)).toEqual(['invalid', 'unmatched', 'ambiguous', 'invalid']); expect(receipt.rows).toHaveLength(4);
  const changed = unwrap(await service.importWorkbook(ops.token, input([row('semantic-phone', { entity: 'contact', customerRef: 'semantic', name: 'changed phone owner', phone: 'semantic phone' })]))); expect(changed.rows[0]!.status).toBe('ambiguous');
  const changedParent = unwrap(await service.importWorkbook(ops.token, input([row('another'), row('semantic-phone', { entity: 'contact', customerRef: 'another', name: 'Synthetic person', phone: 'semantic phone' })]))); expect(changedParent.rows[1]!.status).toBe('ambiguous');
 });
 it('normalizes calendar dates across accepted source formats and returns invalid dates per row', async () => {
  const first = unwrap(await service.importWorkbook(ops.token, input([row('calendar', { sourceCreatedAt: '2026/1/2' }), row('bad-calendar', { sourceCreatedAt: '2026-02-30' })])));
  expect(first.rows.map(x => x.status)).toEqual(['created', 'invalid']);
  const repeat = unwrap(await service.importWorkbook(ops.token, input([row('calendar', { sourceCreatedAt: '2026-01-02' })])));
  expect(repeat.rows[0]).toMatchObject({status:'duplicate',customerId:first.rows[0]!.customerId});
  expect(unwrap(await service.detail(ops.token, first.rows[0]!.customerId!)).sourceCreatedAt).toBe('2026-01-02T00:00:00.000Z');
 });
 it('does not use company names as identity and isolates same source aliases across creators', async () => {
  const request = input([row('alias-a', { companyName: 'Same exact company label' }), row('alias-b', { companyName: 'Same exact company label' })]);
  const own = unwrap(await service.importWorkbook(ops.token, request)); expect(own.rows[0]!.customerId).not.toBe(own.rows[1]!.customerId);
  const other = unwrap(await service.importWorkbook(otherOps.token, { ...request, rows: [request.rows[0]!] })); expect(other.rows[0]!.customerId).not.toBe(own.rows[0]!.customerId);
  const key = await pool.query('SELECT customer_id::text,customer_key FROM crm_customers WHERE customer_id=$1', [own.rows[0]!.customerId]); expect(key.rows[0].customer_key).toBe(key.rows[0].customer_id);
 });
 it('blocks global email conflicts, preserves unassigned siblings and rechecks capability replay', async () => {
  const receipt = unwrap(await service.importWorkbook(otherOps.token, input([row('private-contact', { entity: 'contact', customerRef: 'alias-a', email: `b1-${source}@example.invalid` })]))); expect(receipt.rows[0]).toMatchObject({ status: 'restricted_conflict' }); expect(receipt.rows[0]!.customerId).toBeUndefined();
  const appended = unwrap(await service.importWorkbook(ops.token, input([row('assigned-append', { entity: 'contact', customerRef: 'multi', name: 'New unassigned sibling' })]))); expect(appended.rows[0]!.status).toBe('appended');
  const sibling = (await pool.query('SELECT contact_id FROM crm_customer_contacts WHERE customer_id=$1 ORDER BY contact_id DESC LIMIT 1', [appended.rows[0]!.customerId])).rows[0];
  expect(await contactActions.contactDetail(sales.token, { customerId: appended.rows[0]!.customerId, contactId: sibling.contact_id })).toMatchObject({ error: { code: 'NOT_FOUND' } });
  const request = input([row('replay-capability')]); unwrap(await service.importWorkbook(ops.token, request));
  await pool.query("UPDATE identity.product_access SET capabilities=$2 WHERE user_id=$1 AND product_id='crm'", [ops.id, JSON.stringify(['leads.publish'])]);
  try { expect(await service.importWorkbook(ops.token, request)).toMatchObject({ error: { code: 'FORBIDDEN' } }); } finally { await pool.query("UPDATE identity.product_access SET capabilities=$2 WHERE user_id=$1 AND product_id='crm'", [ops.id, JSON.stringify(capabilitiesFor(['operations']))]); }
  const own = unwrap(await service.importWorkbook(sales.token, request));
  expect(unwrap(await service.detail(sales.token, own.rows[0]!.customerId!))).toMatchObject({ origin: 'personal', ownerUserId: sales.id });
 });
 it('serializes concurrent mappings and catches idempotency key reuse for changed payloads', async () => {
  const request = input([row('concurrent')]); const results = await Promise.all([service.importWorkbook(ops.token, request), service.importWorkbook(ops.token, { ...request, idempotencyKey: randomUUID() })]);
  const rows = results.map(x => unwrap(x).rows[0]!); expect(rows.map(x => x.status).sort()).toEqual(['created', 'duplicate']); expect(rows[0]!.customerId).toBe(rows[1]!.customerId);
  expect(await service.importWorkbook(ops.token, { ...request, sourceDetail: 'changed' })).toMatchObject({ error: { code: 'CONFLICT' } });
 });
 it('hides restricted private drafts before revealing restriction or other business state', async () => {
  const receipt = unwrap(await service.importWorkbook(ops.token, input([row('restriction-visibility', { developmentRestriction: 'PRIVATE_RESTRICTION_SENTINEL' })])));
  const id = receipt.rows[0]!.customerId!;
  const request = { customerId: id, expectedVersion: 1, idempotencyKey: randomUUID() };
  expect(await service.claim(sales.token, request)).toMatchObject({ error: { code: 'CONFLICT' } });
  expect(await service.detail(sales.token, id)).toMatchObject({ error: { code: 'NOT_FOUND' } });
  expect(await service.assign(otherOps.token, { ...request, salesUserId: sales.id, notifyUserIds: [] })).toMatchObject({ error: { code: 'CONFLICT' } });
  expect(await service.publish(otherOps.token, receipt.batchId, { rowIds: [receipt.rows[0]!.rowId], expectedVersion: 1, idempotencyKey: randomUUID() })).toMatchObject({ error: { code: 'NOT_FOUND' } });
 });
 it('preserves omitted profiles, stores optional real contacts, and blocks handing out restricted customers', async () => {
  const customer = unwrap(await service.createCustomer(ops.token, { companyName: 'Synthetic profile', source, sourceDetail: '', idempotencyKey: randomUUID(), contacts: [], businessType: '电商', developmentRestriction: '不跟进', sourceCreatedAt: '2021-03-04' }));
  const edited = unwrap(await service.updateCustomer(ops.token, { customerId: customer.customerId, expectedVersion: customer.version, idempotencyKey: randomUUID(), companyName: 'Synthetic changed', contacts: [{ email: '', phone: 'synthetic phone' }] }));
  expect(edited).toMatchObject({ businessType: '电商', developmentRestriction: '不跟进', sourceCreatedAt: '2021-03-04T00:00:00.000Z' });
  const restricted = unwrap(await service.importWorkbook(ops.token, input([row('restricted', { developmentRestriction: '不跟进' })])));
  const id = restricted.rows[0]!.customerId!; expect(unwrap(await service.detail(ops.token, id)).canAssign).toBe(false);
  expect(await service.assign(ops.token, { customerId: id, expectedVersion: 1, idempotencyKey: randomUUID(), salesUserId: sales.id, notifyUserIds: [] })).toMatchObject({ error: { code: 'CONFLICT' } });
  expect(await service.publish(ops.token, restricted.batchId, { rowIds: [restricted.rows[0]!.rowId], expectedVersion: 1, idempotencyKey: randomUUID() })).toMatchObject({ error: { code: 'CONFLICT' } });
  const clear = unwrap(await service.updateCustomer(ops.token, { customerId: id, expectedVersion: 1, idempotencyKey: randomUUID(), companyName: 'Synthetic restricted', contacts: [], developmentRestriction: '' })); expect(clear.developmentRestriction).toBe('');
  const published = unwrap(await service.publish(ops.token, restricted.batchId, { rowIds: [restricted.rows[0]!.rowId], expectedVersion: 1, idempotencyKey: randomUUID() })); expect(published.publishedCustomerIds).toEqual([id]);
  const note = 'Synthetic customer-level followup';
  const followup = unwrap(await service.followup(ops.token, { customerId: id, expectedVersion: clear.version + 1, idempotencyKey: randomUUID(), note }));
  expect(followup).toMatchObject({ customerId: id, version: clear.version + 2, contacts: [], activities: [{ note, method: 'other', contactId: null, contactStatus: null }] });
 });
 it('rolls back company, customer, mapping and evidence together when atomic outbox insertion fails', async () => {
  await pool.query("CREATE OR REPLACE FUNCTION crm_b1_synthetic_outbox_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; RETURN NEW; END $$");
  const trigger = `b1_test_${sales.id.replace(/-/g, '')}`;
  await pool.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON identity.outbox FOR EACH ROW WHEN (NEW.user_id='${sales.id}'::uuid) EXECUTE FUNCTION crm_b1_synthetic_outbox_failure()`);
  try {
   const request = input([row('rollback-personal')], { kind: 'personal' }); expect(await service.importWorkbook(sales.token, request)).toMatchObject({ error: { code: 'DATABASE_ERROR' } });
   const count = await pool.query('SELECT count(*)::int AS count FROM crm_workbook_source_mappings WHERE actor_id=$1 AND source_ref=$2', [sales.id, 'rollback-personal']); expect(count.rows[0].count).toBe(0);
   const company = await pool.query('SELECT count(*)::int AS count FROM companies WHERE name=$1', ['Synthetic rollback-personal']); expect(company.rows[0].count).toBe(0);
  } finally { await pool.query(`DROP TRIGGER ${trigger} ON identity.outbox`); }
 });
});
