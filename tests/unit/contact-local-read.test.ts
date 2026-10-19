import { describe, expect, it, vi } from 'vitest';
import { contactMirrorPage } from '../../src/main/core/contact-mirror';
import { createContactLocalReadService } from '../../src/main/services/contact-local-read.service';
import { success, failure } from '../../server/core/crm';
import type { CenterContact, CenterContactQuery } from '../../server/core/center-contacts';

const ctx = { baseUrl: 'http://127.0.0.1:55844', userId: 'alice', permissionKey: 'sales' };
const query: CenterContactQuery = { search: '', limit: 2, offset: 0 };
function row(id: number, fields: Partial<CenterContact> = {}): CenterContact {
  return { contactId: id, customerId: `customer-${id}`, customerVersion: 1, contactVersion: 1,
    companyId: 1, companyName: 'Example', email: null, firstName: null, lastName: null, title: null,
    phone: null, linkedinUrl: null, country: null, clientType: null, language: null,
    stage: 'cold', status: '', tags: [], extra: {}, touchStatus: 'uncontacted', assignee: '',
    source: 'manual', sourceDetail: null, createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z',
    ownerUserId: 'alice', ownerName: null, origin: 'personal', state: 'owned', assignmentStatus: null, ...fields };
}
describe('local contact query parity', () => {
  it('filters before counting and paging, keeps literal search characters and nullable fields', () => {
    const rows = [row(1, { firstName: '100%_! Client' }), row(2, { title: '100%_! Manager' }), row(3)];
    expect(contactMirrorPage(rows, { ...query, search: '100%_!', limit: 1, offset: 1 }, 'alice')).toEqual({ items: [rows[0]], total: 2 });
    expect(contactMirrorPage(rows, { ...query, search: '100X' }, 'alice').total).toBe(0);
  });
  it('preserves personal/assigned ownership and actual accepted membership', () => {
    const rows = [row(1), row(2, { origin: 'operations', assignmentStatus: 'accepted' }), row(3, { origin: 'operations' }), row(4, { origin: 'operations', ownerUserId: 'bob', assignmentStatus: 'accepted' })];
    expect(contactMirrorPage(rows, { ...query, scope: 'personal' }, 'alice').items.map(x => x.contactId)).toEqual([1]);
    expect(contactMirrorPage(rows, { ...query, scope: 'assigned' }, 'alice').items.map(x => x.contactId)).toEqual([3, 2]);
    expect(contactMirrorPage(rows, { ...query, assignment: 'accepted' }, 'alice').items.map(x => x.contactId)).toEqual([4, 2]);
  });
  it('keeps sending stage, raw status/tags and relationship stage as separate filters', () => {
    const rows = [row(1, { stage: 'f2', status: 'replied', tags: ['priority'], relationshipStage: 'cooperating', clientType: 'agent', country: 'Brazil', language: 'PT', touchStatus: 'contacted' }), row(2, { relationshipStage: 'quoting' })];
    expect(contactMirrorPage(rows, { ...query, stage: 'f2', status: 'replied', tags: 'priority', clientType: 'agent', country: 'Brazil', language: 'PT', touchStatus: 'contacted', crmStage: 'cooperating' }, 'alice').items).toEqual([rows[0]]);
    expect(contactMirrorPage(rows, { ...query, crmStage: 'quoting' }, 'alice').items).toEqual([rows[1]]);
  });
  it('keeps uncontacted off the board and orders by occurrence time, then update time and ID', () => {
    const rows = [row(1, { touchStatus: 'contacted', lastFollowupAt: '2026-10-14T10:00:00Z', updatedAt: '2026-10-15T20:00:00Z' }), row(2, { touchStatus: 'replied', lastFollowupAt: '2026-10-15T10:00:00Z' }), row(3), row(4, { touchStatus: 'contacted', lastFollowupAt: null })];
    expect(contactMirrorPage(rows, { ...query, limit: 100, followupOnly: true }, 'alice').items.map(x => x.contactId)).toEqual([2, 1, 4]);
    expect(contactMirrorPage(rows, { ...query, followupOnly: true, crmStage: 'reaching' }, 'alice').total).toBe(3);
  });
  it('matches case insensitive names/title/company search and never sorts caller data in place', () => {
    const rows = [row(1, { companyName: 'Vitória' }), row(2, { lastName: 'MÜLLER' }), row(3, { title: 'Agent' })];
    expect(contactMirrorPage(rows, { ...query, search: 'müller' }, 'alice').items).toEqual([rows[1]]);
    expect(contactMirrorPage(rows, { ...query, search: 'vitória' }, 'alice').items).toEqual([rows[0]]);
    expect(rows.map(x => x.contactId)).toEqual([1, 2, 3]);
  });
});
describe('authorized local contact read orchestration', () => {
  it('reads a bounded store page without materializing the account snapshot and discards a session expired during read', async () => {
    let active = true;
    const contacts = () => { throw new Error('full account snapshot must not be read'); };
    const port = { context: () => ({ ...ctx, active: () => active }), ready: () => true, contacts,
      page: () => ({ items: [row(1)], total: 1 }), refresh: async () => success(undefined), report: vi.fn() };
    const service = createContactLocalReadService(port);
    expect(await service.read(query)).toEqual(success({ items: [row(1)], total: 1 }));
    port.page = () => { active = false; return { items: [row(1)], total: 1 }; };
    expect(await service.read(query)).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
  });
  it('rejects an expired session even when a new same-account session has identical permission keys',async()=>{
    let active=true;const captured={...ctx,active:()=>active};let current=captured;const contacts=vi.fn(()=>[row(1)]);
    const service=createContactLocalReadService({context:()=>current,ready:()=>false,contacts,refresh:async()=>{active=false;current={...ctx,active:()=>true};return success(undefined);},report:vi.fn()});
    expect(await service.read(query)).toMatchObject({ok:false,error:{code:'UNAUTHORIZED'}});expect(contacts).not.toHaveBeenCalled();
  });
  function fixture() {
    let current: typeof ctx | null = ctx, ready = true;
    const refresh = vi.fn(async () => { ready = true; return success(undefined); });
    const contacts = vi.fn(() => [row(1)]);
    const service = createContactLocalReadService({ context: () => current, ready: () => ready, contacts, refresh, report: vi.fn() });
    return { service, refresh, contacts, setReady: (value: boolean) => { ready = value; }, setContext: (value: typeof current) => { current = value; } };
  }
  it('serves a complete snapshot without waiting for the network, even for previously unused filters', async () => {
    const f = fixture(); expect(await f.service.read({ ...query, search: 'Example', country: '' })).toEqual(success({ items: [row(1)], total: 1 })); expect(f.refresh).not.toHaveBeenCalled();
  });
  it('bootstraps once before reading and treats a complete empty snapshot as valid', async () => {
    const f = fixture(); f.setReady(false); f.contacts.mockReturnValue([]);
    expect(await f.service.read(query)).toEqual(success({ items: [], total: 0 })); expect(f.refresh).toHaveBeenCalledTimes(1);
  });
  it('does not serve partial data after an initial failed refresh', async () => {
    const f = fixture(); f.setReady(false); f.refresh.mockImplementation(async () => failure('UNAVAILABLE', 'offline') as never);
    expect(await f.service.read(query)).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } }); expect(f.contacts).not.toHaveBeenCalled();
  });
  it.each(['account', 'permission', 'logout'] as const)('drops inflight reads after %s change', async mode => {
    const f = fixture(); f.setReady(false); let finish!: () => void;
    f.refresh.mockImplementation(() => new Promise(resolve => { finish = () => { f.setReady(true); resolve(success(undefined)); }; }));
    const pending = f.service.read(query);
    f.setContext(mode === 'logout' ? null : { ...ctx, ...(mode === 'account' ? { userId: 'bob' } : { permissionKey: 'none' }) }); finish();
    expect(await pending).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } }); expect(f.contacts).not.toHaveBeenCalled();
  });
  it('validates the existing query contract before IO and requires an identity', async () => {
    const f = fixture(); expect(await f.service.read({ ...query, userId: 'bob' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } }); expect(f.contacts).not.toHaveBeenCalled();
    f.setContext(null); expect(await f.service.read(query)).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
  });
});
