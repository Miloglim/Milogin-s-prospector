import { describe, it, expect, vi } from 'vitest';
import { createContactDetailReadService } from '../../src/main/services/contact-detail-read.service';
import { failure, success } from '../../server/core/crm';
import type { CenterContactDetail } from '../../server/core/contact-assignments';
import { createOnlineCrmService } from '../../src/main/services/online-crm.service';
const reference = { contactId: 7, customerId: '00000000-0000-4000-8000-000000000007' };
function fixture() {
  let online = true, active = true, ready = true;
  const ctx = { baseUrl: 'http://127.0.0.1:55844', userId: 'alice', permissionKey: 'sales', active: () => active, online: () => online };
  const contact = { ...reference, companyId: 3, companyName: 'Acme', contactVersion: 4, customerVersion: 2, canEdit: true, canFollowup: true, canAssign: false, firstName: 'Latest' };
  const detail = { contact, company: { companyId: 3, name: 'Acme', domain: 'acme.test', backcheckData: null }, activities: [], mailAvailable: true, mailEvents: [], mailEventLimit: 200, canEdit: true, canFollowup: true, canAssign: false } as unknown as CenterContactDetail;
  let saved: CenterContactDetail | undefined;
  const fetch = vi.fn(async () => success(detail));
  const save = vi.fn((_ctx, value: CenterContactDetail) => { saved = value; });
  const forget = vi.fn(), report = vi.fn(), refresh = vi.fn(async () => { ready = true; return success(undefined); });
  const service = createContactDetailReadService({ context: () => ctx, ready: () => ready, contact: () => contact as never, detail: () => saved, save, forget, fetch, refresh, report });
  return { service, ctx, contact, detail, fetch, save, forget, report, refresh, offline: () => { online = false; }, invalidate: () => { active = false; }, partial: () => { ready = false; }, cached: (value = detail) => { saved = value; } };
}
describe('contact detail unified read', () => {
  it('ignores a stale denial across remove-and-regrant instead of forgetting newly authorized data',async()=>{
    const f=fixture();let revision=0;const forget=vi.fn();
    const service=createContactDetailReadService({context:()=>f.ctx,revision:()=>revision,ready:()=>true,contact:()=>f.contact as never,detail:()=>undefined,save:f.save,forget,fetch:async()=>{revision++;return failure('FORBIDDEN','old denial');},refresh:f.refresh,report:f.report});
    expect(await service.read(reference)).toMatchObject({ok:true});expect(forget).not.toHaveBeenCalled();expect(f.save).not.toHaveBeenCalled();
  });
  it('discards old detail privileges when a complete scan downgraded access in flight',async()=>{
    const f=fixture();const old=structuredClone(f.detail);let finish!:(value:ReturnType<typeof success<CenterContactDetail>>)=>void;
    f.fetch.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));const pending=f.service.read(reference);
    f.contact.canEdit=false;finish(success(old));expect(await pending).toMatchObject({ok:true,data:{canEdit:false}});expect(f.save).not.toHaveBeenCalled();
  });
  it.each(['accepted','denied','switched'] as const)('refreshes an online local miss safely after share %s',async outcome=>{
    const f=fixture();let visible=false,active=true;
    const fetch=vi.fn(async()=>success(f.detail));
    const refresh=vi.fn(async()=>{if(outcome==='accepted')visible=true;if(outcome==='switched')active=false;return success(undefined);});
    const service=createContactDetailReadService({context:()=>({...f.ctx,active:()=>active}),ready:()=>true,contact:()=>visible?f.contact as never:undefined,detail:()=>undefined,save:f.save,forget:f.forget,fetch,refresh,report:f.report});
    const result=await service.read(reference);
    expect(refresh).toHaveBeenCalledTimes(1);
    if(outcome==='accepted'){expect(result).toMatchObject({ok:true});expect(fetch).toHaveBeenCalledTimes(1);expect(f.save).toHaveBeenCalledTimes(1);}
    else {expect(result).toMatchObject({ok:false,error:{code:outcome==='denied'?'NOT_FOUND':'UNAUTHORIZED'}});expect(fetch).not.toHaveBeenCalled();expect(f.save).not.toHaveBeenCalled();}
  });
  it('routes the existing detail IPC service through the local detail port after validation', async () => {
    const detail = vi.fn(async () => success(fixture().detail)), request = vi.fn();
    const service = createOnlineCrmService({ contactDetail: detail, request } as never);
    expect(await service.contactDetail(reference)).toMatchObject({ ok: true }); expect(detail).toHaveBeenCalledWith(reference); expect(request).not.toHaveBeenCalled();
    expect(await service.contactDetail({ ...reference, contactId: 0 })).toMatchObject({ ok: false });
  });
  it('returns local base without inventing downloaded company/history when offline', async () => {
    const f = fixture(); f.offline(); const result = await f.service.read(reference);
    expect(result).toMatchObject({ ok: true, data: { contact: f.contact, supplementAvailable: false, company: { domain: null }, activities: [], mailEvents: [] } });
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it('overlays the current local contact over previously saved history and permissions', async () => {
    const f = fixture(); f.cached({ ...f.detail, contact: { ...f.detail.contact, firstName: 'Old', contactVersion: 1 }, canEdit: false }); f.offline();
    expect(await f.service.read(reference)).toMatchObject({ ok: true, data: { contact: f.contact, canEdit: true, supplementAvailable: true } });
  });
  it('coalesces on-demand online reads and saves the confirmed response', async () => {
    const f = fixture(); await Promise.all([f.service.read(reference), f.service.read(reference)]);
    expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.save).toHaveBeenCalledTimes(1);
  });
  it('falls back only on unavailable network, never on explicit denial or missing record', async () => {
    const f = fixture(); f.cached(); f.fetch.mockResolvedValueOnce(failure('UNAVAILABLE', 'offline') as never);
    expect(await f.service.read(reference)).toMatchObject({ ok: true });
    for (const code of ['FORBIDDEN', 'NOT_FOUND', 'UNAUTHORIZED']) {
      f.fetch.mockResolvedValueOnce(failure(code, 'denied') as never);
      expect(await f.service.read(reference)).toMatchObject({ ok: false, error: { code } });
    }
    expect(f.forget).toHaveBeenCalledTimes(3);
  });
  it('rejects inflight results after account or permission changes', async () => {
    const f = fixture(); let finish!: () => void;
    f.fetch.mockImplementation(() => new Promise(resolve => { finish = () => resolve(success(f.detail)); }));
    const pending = f.service.read(reference); f.invalidate(); finish();
    expect(await pending).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } }); expect(f.save).not.toHaveBeenCalled();
  });
  it('validates identity/reference and requires a complete authorized projection', async () => {
    const f = fixture(); expect(await f.service.read({ ...reference, contactId: -1 })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } }); expect(f.fetch).not.toHaveBeenCalled();
    f.partial(); f.offline(); expect(await f.service.read(reference)).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
  });
  it('rejects a response referring to a different customer/contact rather than persisting it', async () => {
    const f = fixture(); f.fetch.mockResolvedValue(success({ ...f.detail, contact: { ...f.detail.contact, contactId: 8 } }));
    expect(await f.service.read(reference)).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } }); expect(f.save).not.toHaveBeenCalled();
  });
  it('does not merge a new same-account session into an inactive older request', async () => {
    const f = fixture(); let current = f.ctx, finish!: () => void;
    const base = { ...f.ctx }; let oldActive = true;
    const service = createContactDetailReadService({ context: () => current, ready: () => true, contact: () => f.contact as never, detail: () => f.detail, save: f.save, forget: f.forget, fetch: f.fetch, refresh: f.refresh, report: f.report });
    current = { ...base, active: () => oldActive }; f.fetch.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(success(f.detail)); }));
    const older = service.read(reference); oldActive = false; current = { ...base, active: () => true };
    const newer = service.read(reference); finish();
    expect(await older).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } }); expect(await newer).toMatchObject({ ok: true }); expect(f.fetch).toHaveBeenCalledTimes(2);
  });
});
