import { success, failure, type Result } from '../../../server/core/crm';
import { CENTER_CONTACT_LIMITS, type CenterContact, type CenterContactPage, type CenterContactQuery } from '../../../server/core/center-contacts';
import type { ContactMailEventReceipt } from '../../../server/core/contact-mail';
import type { SendAcceptanceReceipt } from '../../../server/core/send-acceptance';
import type { QueuedContactMailEvent } from '../core/contact-mirror';
import { runContactIncrementalSync, type ContactIncrementalPage, type ContactIncrementalStore } from '../core/contact-incremental-sync';

export interface ContactMailSyncContext { baseUrl:string; userId:string; permissionKey?:string; active?():boolean }
export interface ContactMailSyncPort {
  context():ContactMailSyncContext|null; online():boolean;
  query(input:CenterContactQuery):Promise<Result<CenterContactPage>>;
  post(input:QueuedContactMailEvent):Promise<Result<ContactMailEventReceipt|SendAcceptanceReceipt>>;
  replace(ctx:ContactMailSyncContext,rows:CenterContact[]):void;
  contains?(ctx:ContactMailSyncContext,row:CenterContact):boolean;
  upsert(ctx:ContactMailSyncContext,rows:CenterContact[]):void;
  pending(ctx:ContactMailSyncContext):QueuedContactMailEvent[];
  acknowledge(ctx:ContactMailSyncContext,eventKey:string,event?:QueuedContactMailEvent):void;
  blockEvent?(ctx:ContactMailSyncContext,eventKey:string,message:string):void;
  reconcile():Promise<Result<unknown>>;
  report(error:unknown):void;
  incremental?: {
    store: ContactIncrementalStore;
    fetchPage: (cursor: string | null) => Promise<ContactIncrementalPage | undefined>;
    head?: () => Promise<string | undefined>;
    reconcile?: () => Promise<Result<unknown>>;
  };
}
const MAX_CONTACT_SCAN_PAGES=1000;
const identityKey=(ctx:ContactMailSyncContext)=>JSON.stringify([ctx.baseUrl,ctx.userId,ctx.permissionKey]);
/** Dataflow only: full authorized refresh and explicit receipt; conflict UI and retry policy are separate nodes. */
export function createContactMailSyncService(port:ContactMailSyncPort) {
  let running:Promise<Result<void>>|null=null;
  let refreshRequested=false;
  let flushing:Promise<Result<void>>|null=null;
  let lastProjection='';
  let projectionRevision=0;
  const observedVersions=new Map<string,number>();
  const versionKey=(ctx:ContactMailSyncContext,row:CenterContact)=>identityKey(ctx)+':'+row.contactId;
  const version=(row:CenterContact)=>row.contactVersion??row.customerVersion??0;
  function remember(ctx:ContactMailSyncContext,rows:CenterContact[]) {for(const row of rows)observedVersions.set(versionKey(ctx,row),version(row));}
  function upsertCurrent(ctx:ContactMailSyncContext,row:CenterContact) {
    if(port.contains&&!port.contains(ctx,row))return;
    if(version(row)<(observedVersions.get(versionKey(ctx,row))??0))return;
    projectionRevision++;port.upsert(ctx,[row]);remember(ctx,[row]);
  }
  const active=(ctx:ContactMailSyncContext)=>{const now=port.context();return ctx.active?.()!==false&&!!now&&now.active?.()!==false&&identityKey(now)===identityKey(ctx);};
  async function perform():Promise<Result<void>> {
    const ctx=port.context();if(!ctx)return failure('UNAUTHORIZED','请登录中心账号');
    if(!port.online())return failure('UNAVAILABLE','中心暂时不可用，邮件事件保留在本地');
    try {
      const incremental = port.incremental;
      if (incremental) {
        const state = incremental.store.state(ctx);
        // A null cursor means the mirror has no complete baseline yet. Keep
        // the existing full authorized scan as the authoritative bootstrap.
        if (state.cursor !== null) {
          const result = await runContactIncrementalSync(ctx, incremental.store, incremental.fetchPage);
          if (result.kind === 'incremental') {
            if (incremental.reconcile) {
              const reconciled = await incremental.reconcile();
              if (!reconciled.ok) return reconciled as Result<void>;
            }
            return await flush();
          }
        }
      }
      const baselineHead = incremental?.head ? await incremental.head() : undefined;
      const scanRevision=projectionRevision;
      const rows:CenterContact[]=[];const seen=new Set<number>();let complete=false;let expectedTotal:number|undefined;
      for(let page=0;page<MAX_CONTACT_SCAN_PAGES;page++) {
        const result=await port.query({search:'',scope:'all',limit:CENTER_CONTACT_LIMITS.pageMax,offset:rows.length});
        if(!active(ctx))return failure('UNAUTHORIZED','账号已切换，旧同步已停止');
        if(!result.ok)return result;
        if(expectedTotal===undefined)expectedTotal=result.data.total;
        if(result.data.total!==expectedTotal)return failure('CONFLICT','联系人总数已变化，本轮列表已丢弃');
        for(const row of result.data.items){if(seen.has(row.contactId))return failure('CONFLICT','联系人列表已变化，请重新同步');seen.add(row.contactId);rows.push(row);}
        if(rows.length>expectedTotal)return failure('CONFLICT','联系人数量不一致，本轮列表已丢弃');
        if(rows.length===expectedTotal){complete=true;break;}
        if(!result.data.items.length)return failure('CONFLICT','联系人列表已变化，请重新同步');
      }
      if(!complete)return failure('UNAVAILABLE','联系人数量超过本轮同步范围');
      if(scanRevision!==projectionRevision)return failure('CONFLICT','联系人同步期间已更新，本轮旧列表已丢弃');
      if(rows.some(row=>version(row)<(observedVersions.get(versionKey(ctx,row))??0)))return failure('CONFLICT','联系人旧版本已丢弃');
      port.replace(ctx,rows);
      if (incremental?.store.saveCursor && baselineHead !== undefined) incremental.store.saveCursor(ctx, baselineHead);
      projectionRevision++;
      remember(ctx,rows);
      const projection=identityKey(ctx)+JSON.stringify(rows.map(row=>[row.contactId,row.customerId,row.contactVersion,row.email]));
      if(projection!==lastProjection){const reconciled=await port.reconcile();if(!active(ctx))return failure('UNAUTHORIZED','账号已切换');if(!reconciled.ok)return reconciled;lastProjection=projection;}
      return await flush();
    } catch(error){port.report(error);return failure('DATABASE_ERROR','本地邮件同步未完成，待同步记录已保留');}
  }
  async function performFlush():Promise<Result<void>> {
    const ctx=port.context();if(!ctx)return failure('UNAUTHORIZED','请登录中心账号');
    if(!port.online())return failure('UNAVAILABLE','中心暂时不可用，邮件事件保留在本地');
    try {
      let blocked:Result<void>|undefined;
      while(active(ctx)) {
        const pending=port.pending(ctx);if(!pending.length)return blocked??success(undefined);
        for(const event of pending) {
        if(!active(ctx))return failure('UNAUTHORIZED','账号已切换');
        const receiptRevision=projectionRevision;
        const result=await port.post(event);if(!active(ctx))return failure('UNAUTHORIZED','账号已切换');
        if(!result.ok){
          if(port.blockEvent&&(['FORBIDDEN','NOT_FOUND'].includes(result.error.code)||result.error.code==='CONFLICT'&&event.correction)){
            // Retain the original local fact without repeatedly blocking unrelated contacts.
            port.blockEvent(ctx,event.eventKey,result.error.message);blocked=result;continue;
          }
          return result;
        }
        if('contact' in result.data&&receiptRevision===projectionRevision)upsertCurrent(ctx,result.data.contact);
        port.acknowledge(ctx,event.eventKey,event);
        }
      }
      return failure('UNAUTHORIZED','账号已切换');
    } catch(error){port.report(error);return failure('DATABASE_ERROR','本地邮件同步未完成，待同步记录已保留');}
  }
  function flush():Promise<Result<void>> {if(flushing)return flushing;const job=performFlush().finally(()=>{if(flushing===job)flushing=null;});flushing=job;return job;}
  function sync():Promise<Result<void>> {
    if(running){refreshRequested=true;return running;}
    const job=(async()=>{let result:Result<void>;do{refreshRequested=false;result=await perform();}while(refreshRequested&&port.context()&&port.online());return result;})().finally(()=>{if(running===job)running=null;});
    running=job;return job;
  }
  return {
    sync,
    flush,
    /** Known authorization/deletion facts also invalidate scans that started earlier. */
    invalidate(ctx:ContactMailSyncContext):void {
      if(!active(ctx))return;
      projectionRevision++;lastProjection='';
    },
    observe(ctx:ContactMailSyncContext,data:unknown):void {
      if(!active(ctx)||!data||typeof data!=='object')return;
      const detail=data as {contact?:CenterContact};
      if(detail.contact&&Number.isSafeInteger(detail.contact.contactId)&&typeof detail.contact.customerId==='string')upsertCurrent(ctx,detail.contact);
    },
  };
}
