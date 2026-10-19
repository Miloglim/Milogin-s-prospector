import { failure, success, type Result } from '../../../server/core/crm';
import { isCenterUnavailable } from '../../../server/core/offline-access';
import type { CenterContact } from '../../../server/core/center-contacts';
import type { CenterContactDetail, CenterContactRef } from '../../../server/core/contact-assignments';
import { contactRef } from '../../../server/services/contact-assignments';
import { contactDetailSnapshot, type ContactMirrorContext } from '../core/contact-mirror';
import { contactAccessFingerprint } from '../core/contact-commands';

interface DetailContext extends ContactMirrorContext { active(): boolean; online(): boolean; }
export interface ContactDetailReadPort {
  context(): DetailContext | null;
  revision?(ctx: DetailContext, ref: CenterContactRef): number;
  ready(ctx: DetailContext): boolean;
  contact(ctx: DetailContext, ref: CenterContactRef): CenterContact | undefined;
  detail(ctx: DetailContext, ref: CenterContactRef): CenterContactDetail | undefined;
  save(ctx: DetailContext, detail: CenterContactDetail): void;
  forget(ctx: DetailContext, ref: CenterContactRef): void;
  fetch(ref: CenterContactRef): Promise<Result<CenterContactDetail>>;
  refresh(): Promise<Result<unknown>>;
  report(error: unknown): void;
}
/** One base projection; company/history supplements are fetched only when viewed. */
export function createContactDetailReadService(port: ContactDetailReadPort) {
  const requests = new Map<string, { ctx: DetailContext; job: Promise<Result<CenterContactDetail>> }>();
  function local(ctx: DetailContext, ref: CenterContactRef): Result<CenterContactDetail> {
    if (!ctx.active()) return failure('UNAUTHORIZED', '账号已切换');
    if (!port.ready(ctx)) return failure('UNAVAILABLE', '联系人尚未完成同步');
    const contact = port.contact(ctx, ref);
    if (!contact) return failure('NOT_FOUND', '联系人不在当前授权范围');
    return success(contactDetailSnapshot(contact, port.detail(ctx, ref)));
  }
  async function perform(ctx: DetailContext, ref: CenterContactRef): Promise<Result<CenterContactDetail>> {
    try {
      if (!port.ready(ctx) && ctx.online()) {
        const refresh = await port.refresh();
        if (!ctx.active()) return failure('UNAUTHORIZED', '账号已切换');
        if (!port.ready(ctx)) return refresh.ok ? failure('UNAVAILABLE', '联系人尚未完成同步') : refresh;
      }
      let snapshot = local(ctx, ref);
      if(!snapshot.ok&&snapshot.error.code==='NOT_FOUND'&&ctx.online()){
        // Acceptance can precede completion of the background authorized projection.
        // Refresh membership first; never fetch an arbitrary locally excluded reference.
        const refreshed=await port.refresh();
        if(!ctx.active())return failure('UNAUTHORIZED','账号或权限已变化，旧详情已丢弃');
        if(!refreshed.ok)return refreshed;
        snapshot=local(ctx,ref);
      }
      if (!snapshot.ok || !ctx.online()) return snapshot;
      const access=contactAccessFingerprint(snapshot.data);
      const revision=port.revision?.(ctx,ref);
      const fresh = await port.fetch(ref);
      if (!ctx.active()) return failure('UNAUTHORIZED', '账号或权限已变化，旧详情已丢弃');
      const current=local(ctx,ref);
      if(!current.ok||port.revision?.(ctx,ref)!==revision||contactAccessFingerprint(current.data)!==access)return current;
      if (!fresh.ok) {
        if (['FORBIDDEN', 'NOT_FOUND', 'UNAUTHORIZED'].includes(fresh.error.code)) { port.forget(ctx, ref); return fresh; }
        return isCenterUnavailable(fresh.error.code) ? local(ctx, ref) : fresh;
      }
      if (fresh.data.contact.contactId !== ref.contactId || fresh.data.contact.customerId !== ref.customerId) return failure('UNAVAILABLE', '中心详情关联不一致');
      // A complete scan may have removed this contact while the request was in flight.
      if (!port.ready(ctx) || !port.contact(ctx, ref)) return failure('NOT_FOUND', '联系人不在当前授权范围');
      port.save(ctx, fresh.data);
      return local(ctx, ref);
    } catch (error) { port.report(error); return failure('DATABASE_ERROR', '联系人详情读取失败'); }
  }
  return { read(input: unknown): Promise<Result<CenterContactDetail>> {
    const parsed = contactRef(input); if (!parsed.ok) return Promise.resolve(parsed);
    const ctx = port.context(); if (!ctx || !ctx.active()) return Promise.resolve(failure('UNAUTHORIZED', '请登录中心账号'));
    const key = JSON.stringify([ctx.baseUrl, ctx.userId, ctx.permissionKey, parsed.data.customerId, parsed.data.contactId]);
    const pending = requests.get(key); if (pending?.ctx.active()) return pending.job;
    const job = perform(ctx, parsed.data).finally(() => { if (requests.get(key)?.job === job) requests.delete(key); });
    requests.set(key, { ctx, job }); return job;
  } };
}
