import { describe, expect, it, vi } from 'vitest';
import { centerContactQuery, centerContactPath } from '../../server/core/center-contacts';
import { createOnlineCrmService } from '../../src/main/services/online-crm.service';
import { createOfflineCrmService } from '../../src/main/services/offline-crm.service';
import { emptyOfflineCrmState, type OfflineCrmContext } from '../../src/main/core/offline-crm';
import { success, failure } from '../../server/core/crm';

describe('contact assignment desktop boundary', () => {
  it('roundtrips source, acceptance and board filters without accepting an actor override', () => {
    const input = { search: '', limit: 50, offset: 0, scope: 'assigned', assignment: 'accepted', followupOnly: true, crmStage: 'quoting' };
    const result = centerContactQuery(input);
    expect(result).toEqual(success(input));
    if (result.ok) {
      const params = new URL(centerContactPath(result.data), 'http://fixture').searchParams;
      for (const [key, value] of Object.entries(input)) expect(params.get(key)).toBe(String(value));
    }
    for (const invalid of [{ ...input, scope: 'another-user' }, { ...input, followupOnly: 'true' }, { ...input, crmStage: 'made-up' }, { ...input, ownerUserId: 'another-user' }]) expect(centerContactQuery(invalid).ok).toBe(false);
  });

  it('uses contact request routes and never the legacy SQLite transport', async () => {
    const request = vi.fn(async () => success({}));
    const service = createOnlineCrmService({ request, login: vi.fn(), logout: vi.fn(), preview: vi.fn(), feed: vi.fn() });
    const customerId = '00000000-0000-4000-8000-000000000001';
    const requestId = '00000000-0000-4000-8000-000000000002';
    await service.contactDetail({ contactId: 7, customerId });
    await service.acceptAssignment({ requestId, expectedVersion: 1, idempotencyKey: 'accept-one' });
    expect(request.mock.calls).toEqual([
      ['GET', `/api/crm/contacts/7?customerId=${customerId}`],
      ['POST', `/api/crm/contact-assignments/${requestId}/accept`, { requestId, expectedVersion: 1, idempotencyKey: 'accept-one' }],
    ]);
  });

  it('keeps acceptance online and invalidates contact cache after a successful decision', async () => {
    let state = emptyOfflineCrmState('sales');
    const path = '/api/crm/contacts?search=&limit=50&offset=0';
    state.cache[path] = { items: [], total: 0 };
    const context: OfflineCrmContext = { userId: 'user', baseUrl: 'http://fixture', permissionKey: 'sales', active: () => true, online: () => false };
    const service = createOfflineCrmService({ load: () => structuredClone(state), save: (_ctx, next) => { state = structuredClone(next); } }, () => 'operation', () => '2026-10-14T00:00:00.000Z');
    const network = vi.fn(async (method: string) => method === 'POST' ? success({ status: 'accepted' }) : failure('UNAVAILABLE', 'synthetic unavailable'));
    const decisionPath = '/api/crm/contact-assignments/request/accept';
    expect(await service.request(context, 'POST', decisionPath, {}, network as never)).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
    expect(state.outbox).toHaveLength(0);
    await service.request({ ...context, online: () => true }, 'POST', decisionPath, {}, network as never);
    expect(state.cache[path]).toBeUndefined();
  });

  it('checks current online ownership before returning an earlier contact snapshot', async () => {
    let state = emptyOfflineCrmState('sales');
    const path='/api/crm/contacts/7?customerId=customer';
    state.cache[path]={contact:{contactId:7,firstName:'Old cached name'}};
    const context:OfflineCrmContext={userId:'user',baseUrl:'http://fixture',permissionKey:'sales',active:()=>true,online:()=>true};
    const service=createOfflineCrmService({load:()=>structuredClone(state),save:(_ctx,next)=>{state=structuredClone(next);}},()=> 'operation',()=> '2026-10-14T00:00:00.000Z');
    const denied=async()=>failure('NOT_FOUND','not accessible');
    expect(await service.request(context,'GET',path,undefined,denied)).toMatchObject({ok:false,error:{code:'NOT_FOUND'}});
    expect(state.cache[path]).toBeUndefined();
    expect(await service.request({...context,online:()=>false},'GET',path,undefined,denied)).toMatchObject({ok:false});
  });

  it('does not report imported before the center acknowledges the original command',async()=>{
    let state=emptyOfflineCrmState('sales');
    const service=createOfflineCrmService({load:()=>structuredClone(state),save:(_ctx,next)=>{state=structuredClone(next);}},()=> 'operation',()=> '2026-10-14T00:00:00.000Z');
    const context:OfflineCrmContext={userId:'user',baseUrl:'http://fixture',permissionKey:'sales',active:()=>true,online:()=>true};
    const command={source:'desktop-import',sourceDetail:'fixture',idempotencyKey:'original-import',rows:[]};
    const network=vi.fn(async()=>failure('FORBIDDEN','center rejected import'));
    expect(await service.request(context,'POST','/api/crm/imports',command,network,true)).toMatchObject({ok:false,error:{code:'FORBIDDEN'}});
    expect(state.outbox).toHaveLength(0);expect(network).toHaveBeenCalledWith('POST','/api/crm/imports',command);
    expect(await service.request({...context,online:()=>false},'POST','/api/crm/imports',command,network,true)).toMatchObject({ok:false,error:{code:'UNAVAILABLE'}});
    expect(network).toHaveBeenCalledTimes(1);
  });
});
