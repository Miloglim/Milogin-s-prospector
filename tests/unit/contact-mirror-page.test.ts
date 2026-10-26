import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as NativeDatabase } from 'node:sqlite';
import type { Database } from 'better-sqlite3';
import type { CenterContact, CenterContactQuery } from '../../server/core/center-contacts';
import { contactDetailSnapshot, contactMirrorPage } from '../../src/main/core/contact-mirror';
import { SqliteContactMirrorStore } from '../../src/main/adapters/contact-mirror-store.adapter';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const ctx = { baseUrl: 'https://center.test', userId: 'alice', permissionKey: 'sales' };
const query: CenterContactQuery = { search: '', offset: 0, limit: 2 };
const databases: NativeDatabase[] = [];
const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of databases) db.close(); databases.length = 0; for (const directory of directories) rmSync(directory, { recursive: true, force: true }); directories.length = 0; });
function fixture(existing?: NativeDatabase) {
  const raw = existing ?? new DatabaseSync(':memory:');
  if (!existing) databases.push(raw);
  const calls = { lower: 0 };
  const db = {
    exec: (sql: string) => raw.exec(sql), prepare: (sql: string) => raw.prepare(sql),
    function: (name: string, options: object, fn: (...args: never[]) => unknown) => raw.function(name, options, ((value: never) => { if (name === 'crm_contact_lower') calls.lower++; return fn(value); }) as never),
    transaction: (work: () => unknown) => () => { raw.exec('BEGIN'); try { const value = work(); raw.exec('COMMIT'); return value; } catch (error) { raw.exec('ROLLBACK'); throw error; } },
  } as unknown as Database;
  return { raw, db, calls, store: new SqliteContactMirrorStore(() => db) };
}
function row(contactId: number, fields: Partial<CenterContact> = {}): CenterContact {
  return { contactId, customerId: `customer-${contactId}`, customerVersion: 2, contactVersion: 3,
    companyId: 4, companyName: 'Acme', email: null, firstName: null, lastName: null, title: null,
    phone: null, linkedinUrl: null, country: null, clientType: null, language: null,
    stage: 'cold', status: '', tags: [], extra: {}, touchStatus: 'uncontacted', assignee: '',
    source: 'manual', sourceDetail: null, createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z',
    ownerUserId: 'alice', ownerName: null, origin: 'personal', state: 'owned', assignmentStatus: null, ...fields };
}
describe('indexed SQLite contact pages', () => {
  it('updates an incremental batch without decoding unrelated mirror rows', () => {
    const { store } = fixture();
    const rows = Array.from({ length: 5_000 }, (_, index) => row(index + 1));
    store.replaceContacts(ctx, rows);
    const fullRead = vi.spyOn(store, 'contacts');
    store.upsertContacts(ctx, [{ ...rows[0]!, contactVersion: 4, firstName: 'updated' }]);
    expect(fullRead).not.toHaveBeenCalled();
    expect(store.contacts(ctx)).toHaveLength(5_000);
  });
  it('keeps count and items on one WAL read snapshot while another connection updates the cache', () => {
    const directory = mkdtempSync(join(tmpdir(), 'prospector-contact-page-')); directories.push(directory);
    const file = join(directory, 'isolated.db');
    const left = new DatabaseSync(file), right = new DatabaseSync(file); databases.push(left, right);
    left.exec('PRAGMA journal_mode=WAL');
    const reader = fixture(left), writer = fixture(right), initial = row(1);
    reader.store.replaceContacts(ctx, [initial]); writer.store.ready(ctx);
    const prepare = reader.db.prepare.bind(reader.db); let changed = false;
    vi.spyOn(reader.db, 'prepare').mockImplementation(((sql: string) => {
      const statement = prepare(sql);
      if (sql.startsWith('SELECT COUNT(*)')) {
        const get = statement.get.bind(statement);
        statement.get = ((...parameters: unknown[]) => {
          const result = get(...parameters);
          if (!changed) { changed = true; writer.store.upsertContacts(ctx, [{ ...initial, contactVersion: 4, firstName: 'changed' }, row(2)]); }
          return result;
        }) as typeof statement.get;
      }
      return statement;
    }) as typeof reader.db.prepare);
    expect(reader.store.page(ctx, query)).toEqual({ items: [initial], total: 1 });
    expect(reader.store.page(ctx, query)).toMatchObject({ items: [{ contactId: 2 }, { contactId: 1, firstName: 'changed' }], total: 2 });
  });
  it('searches each normalized field from the index without per-row JavaScript callbacks or cross-field matches', () => {
    const { store, calls } = fixture();
    store.replaceContacts(ctx, [row(1, { firstName: 'AB', lastName: 'CD' }), row(2, { title: 'MÜLLER' })]);
    calls.lower = 0;
    expect(store.page(ctx, { ...query, search: 'müller' }).items).toMatchObject([{ contactId: 2 }]);
    expect(store.page(ctx, { ...query, search: 'bc' })).toEqual({ items: [], total: 0 });
    expect(calls.lower).toBe(0);
  });
  it('counts and pages in SQLite without reading a full account snapshot', () => {
    const { store } = fixture(); const rows = [row(1), row(2), row(3)]; store.replaceContacts(ctx, rows);
    store.contacts = () => { throw new Error('full snapshot read forbidden'); };
    const parse = vi.spyOn(JSON, 'parse');
    expect(store.page(ctx, query)).toEqual({ items: [rows[2], rows[1]], total: 3 });
    expect(parse).toHaveBeenCalledTimes(query.limit);
    expect(store.page(ctx, { ...query, offset: 99 })).toEqual({ items: [], total: 3 });
    expect(parse).toHaveBeenCalledTimes(query.limit);
  });
  it('matches the original filter/count/order contract for Unicode, literals, scope, tags, stages and instant times', () => {
    const { store } = fixture();
    const rows = [
      row(1, { firstName: 'MÜLLER 100%_! O\'Neil', tags: ['x', 'priority'], stage: 'f2', status: 'replied', country: 'Brazil', language: 'PT', clientType: 'agent', touchStatus: 'contacted', relationshipStage: 'cooperating', lastFollowupAt: '2026-10-15T10:00:00+08:00', updatedAt: '2026-10-15T10:00:00+08:00' }),
      row(2, { origin: 'operations', assignmentStatus: 'accepted', touchStatus: 'replied', lastFollowupAt: '2026-10-15T03:00:00Z', updatedAt: '2026-10-15T03:00:00Z' }),
      row(3, { origin: 'operations', ownerUserId: 'bob', isShared: true, touchStatus: 'contacted', lastFollowupAt: null }),
      row(4, { lastName: 'İSTANBUL', companyName: 'Vitória', updatedAt: '2026-10-15T02:00:00Z' }),
      row(5, { title: 'Σ ΑΒΓ', touchStatus: 'autoreply' }),
      row(6, { origin: 'operations', ownerUserId: 'bob', assignmentStatus: 'accepted', touchStatus: 'contacted', lastFollowupAt: '2026-10-15T03:00:00.001Z' }),
    ];
    store.replaceContacts(ctx, rows);
    const variants: Partial<CenterContactQuery>[] = [{}, { offset: 99 }, { scope: 'personal' }, { scope: 'assigned' }, { assignment: 'accepted' }, { followupOnly: true }, { crmStage: 'reaching' }, { touchStatus: 'autoreply' }, { search: 'müller' }, { search: 'vitória' }, { search: 'i̇stanbul' }, { search: 'σ αβγ' }, { search: '100%_!' }, { search: "o'neil" }, { search: '100X' }, { tags: 'priority' }, { stage: 'f2', status: 'replied', country: 'Brazil', language: 'PT', clientType: 'agent', touchStatus: 'contacted', crmStage: 'cooperating' }, { followupOnly: true, scope: 'assigned', assignment: 'accepted' }];
    for (const variant of variants) for (const offset of [0, 1, 9]) {
      const input = { ...query, ...variant, offset };
      expect(store.page(ctx, input), JSON.stringify(input)).toEqual(contactMirrorPage(rows, input, ctx.userId));
    }
  });
  it('keeps indexes current through upsert, stale writes, details, deletion and reopen', () => {
    const { raw, store } = fixture(); const initial = row(1); store.replaceContacts(ctx, [initial]);
    store.upsertContacts(ctx, [{ ...initial, contactVersion: 4, firstName: 'MÜLLER', updatedAt: '2026-10-15T00:00:00Z' }]);
    store.upsertContacts(ctx, [{ ...initial, contactVersion: 2, firstName: 'obsolete' }]);
    expect(fixture(raw).store.page(ctx, { ...query, search: 'müller' }).total).toBe(1);
    store.saveDetail(ctx, contactDetailSnapshot({ ...initial, contactVersion: 5, firstName: 'Vitória', lastFollowupAt: '2026-10-16T00:00:00Z', touchStatus: 'contacted' }));
    expect(store.page(ctx, { ...query, search: 'müller' }).total).toBe(0);
    expect(store.page(ctx, { ...query, search: 'vitória', followupOnly: true }).items).toMatchObject([{ contactId: 1, contactVersion: 5 }]);
    store.forgetContact(ctx, initial);
    expect(store.page(ctx, query)).toEqual({ items: [], total: 0 });
  });
  it('upgrades existing snapshot-only caches before serving indexed pages', () => {
    const raw = new DatabaseSync(':memory:'); databases.push(raw);
    raw.exec('CREATE TABLE crm_contact_mirror(contact_id INTEGER PRIMARY KEY,customer_id TEXT NOT NULL,email_normalized TEXT,snapshot TEXT NOT NULL)');
    raw.prepare('INSERT INTO crm_contact_mirror VALUES(?,?,?,?)').run(1, 'customer-1', null, JSON.stringify(row(1, { firstName: 'MÜLLER' })));
    expect(fixture(raw).store.page(ctx, { ...query, search: 'müller' })).toEqual({ items: [row(1, { firstName: 'MÜLLER' })], total: 1 });
  });
  it.each([
    [{}, 'crm_contact_mirror_page'],
    [{ followupOnly: true }, 'crm_contact_mirror_followup_v2_page'],
    [{ scope: 'personal' }, 'crm_contact_mirror_source_page'],
  ] as const)('uses an ordering index for %j without a temporary sort', (variant, index) => {
    const { db, raw, store } = fixture(); store.replaceContacts(ctx, [row(1, { touchStatus: 'contacted' })]);
    const plans: string[] = []; const prepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      if (sql.startsWith('SELECT snapshot FROM crm_contact_mirror')) {
        const placeholders = (sql.match(/\?/g) ?? []).length;
        const parameters = variant.scope === 'personal' ? ['alice', 2, 0] : [2, 0];
        plans.push(...raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters.slice(0, placeholders)).map(row => String(row.detail)));
      }
      return prepare(sql);
    }) as typeof db.prepare);
    expect(store.page(ctx, { ...query, ...variant }).total).toBe(1);
    expect(plans.join('\n')).toContain(index);
    expect(plans.join('\n')).not.toContain('TEMP B-TREE');
  });
});
