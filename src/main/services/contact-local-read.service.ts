import { centerContactQuery, type CenterContact, type CenterContactPage, type CenterContactQuery } from '../../../server/core/center-contacts';
import { failure, success, type Result } from '../../../server/core/crm';
import { contactMirrorPage, type ContactMirrorContext } from '../core/contact-mirror';

export interface ContactLocalReadPort {
  context(): (ContactMirrorContext & { active?(): boolean }) | null;
  ready(context: ContactMirrorContext): boolean;
  contacts(context: ContactMirrorContext): CenterContact[];
  page?(context: ContactMirrorContext, query: CenterContactQuery): CenterContactPage;
  refresh(): Promise<Result<unknown>>;
  report(error: unknown): void;
}
const key = (ctx: ContactMirrorContext) => JSON.stringify([ctx.baseUrl, ctx.userId, ctx.permissionKey]);
/** IO stays in ports; complete account snapshots can answer new offline queries. */
export function createContactLocalReadService(port: ContactLocalReadPort) {
  return { async read(input: unknown): Promise<Result<CenterContactPage>> {
    const parsed = centerContactQuery(input); if (!parsed.ok) return parsed;
    const ctx = port.context(); if (!ctx) return failure('UNAUTHORIZED', '请登录中心账号');
    const active = () => { const current = port.context(); return ctx.active?.()!==false&&!!current&&current.active?.()!==false&&key(current) === key(ctx); };
    try {
      if (!port.ready(ctx)) {
        const refreshed = await port.refresh();
        if (!active()) return failure('UNAUTHORIZED', '账号或权限已变化，旧读取已丢弃');
        if (!port.ready(ctx)) return refreshed.ok ? failure('UNAVAILABLE', '请联网完成联系人同步') : refreshed;
      }
      if (!active()) return failure('UNAUTHORIZED', '请重新登录中心账号');
      const page = port.page ? port.page(ctx, parsed.data) : contactMirrorPage(port.contacts(ctx), parsed.data, ctx.userId);
      if (!active()) return failure('UNAUTHORIZED', '账号或权限已变化，旧读取已丢弃');
      return success(page);
    } catch (error) { port.report(error); return failure('DATABASE_ERROR', '本地联系人读取失败'); }
  } };
}
