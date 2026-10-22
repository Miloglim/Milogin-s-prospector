import { canSendToContact } from '../core/contact-permissions';
import { randomUUID } from 'node:crypto';
import type { OnlineCrmAdapter } from './online-crm.adapter';
import { createContactMirrorStore } from './contact-mirror-store.adapter';
import { createLegacyContactMapStore } from './legacy-contact-map-store.adapter';
import { createLegacyContactSyncStore } from './legacy-contact-sync-store.adapter';
import { getRawDb } from '../db';
import { createContactMailSyncService } from '../services/contact-mail-sync.service';
import { setInboxCenterContactPort, reconcileInboxCenterContacts, replayInboxCenterClassificationChanges } from '../services/inbox.service';
import { readMailboxSnapshot } from './inbox-center-contact.adapter';
import { centerContactPath } from '../../../server/core/center-contacts';
import { readAllCenterContactsForMatch } from '../services/contact-match-reader.service';
import { CONTACT_MAIL_ROUTE } from '../../../server/core/contact-mail';
import { SEND_ACCEPTANCE_ROUTES } from '../../../server/core/send-acceptance';
import { failure, success } from '../../../server/core/crm';
import { okResult, failResult } from '../errors';
import { Log } from '../logger';
import { centerContactDisplayStatus } from '../../shared/online-crm';
import { createContactLocalReadService } from '../services/contact-local-read.service';
import { createContactDetailReadService } from '../services/contact-detail-read.service';
import { CONTACT_ASSIGNMENT_ROUTES, type CenterContactDetail } from '../../../server/core/contact-assignments';
import { createContactCommandService } from '../services/contact-command.service';
import { OFFLINE_CRM_LIMITS } from '../core/offline-crm';
import { contactDetailSnapshot } from '../core/contact-mirror';
import { contactAccessFingerprint } from '../core/contact-commands';
import type { ContactMirrorContext } from '../core/contact-mirror';
import { buildLegacyPersonalImport } from '../core/legacy-contact-sync';
import { createLegacyMailSyncStore } from './legacy-mail-sync-store.adapter';
import type { CenterContact } from '../../../server/core/center-contacts';
import type { CenterContactRef } from '../../../server/core/contact-assignments';
import { CONTACT_CHANGE_ROUTE, type ContactChangePage } from '../../../server/core/contact-change-feed';
import { bindCenterSendRuntime } from './center-send-runtime.adapter';
import { onContactSignal } from '../services/campaign.service';
import { setAgentContactPort } from '../services/agent-contact.service';
import { LEAD_ROUTES } from '../../../server/core/leads';
import { TASK_ROUTES } from '../../../server/core/tasks';
import type { ContactIncrementalPage } from '../core/contact-incremental-sync';

const REFRESH_INTERVAL_MS=60000;
const MAIL_FLUSH_DELAY_MS=500;
const RECONCILE_PAGE_SIZE=500;
const MILLISECONDS_PER_SECOND=1000;
const MATCH_CONTACTS_CACHE_TTL_MS=2000;
/** Loaded only after the user's local DB/profile is selected; never captures an anonymous DB. */
export function startContactMailRuntime(parent:string,adapter:OnlineCrmAdapter,changed:()=>void) {
  const mirror=createContactMirrorStore(parent);
  const legacyContactMap=createLegacyContactMapStore(getRawDb());
  const legacyContactSync=createLegacyContactSyncStore(getRawDb());
  const legacyMailSync=createLegacyMailSyncStore(getRawDb());
  let legacySyncBusy=false;
  const flushLegacyContacts=async():Promise<void>=>{
    if (legacySyncBusy || !adapter.isOnline() || !adapter.legacyPersonalImportAllowed()) return;
    legacySyncBusy=true;
    try {
      legacyContactSync.enqueueUnmatched();
      const pending=legacyContactSync.pending();
      if (!pending.length) { await flushLegacyMail(); return; }
      const request=buildLegacyPersonalImport(pending.map(row=>row.payload),pending.map(row=>row.localContactId).join('-'));
      const result=await adapter.requestLive<import('../../../server/core/leads').ImportReceipt>('POST',LEAD_ROUTES.imports,request);
      if (!result.ok) { legacyContactSync.defer(pending.map(row=>row.localContactId),result.error.message); return; }
      const failed = new Set(result.data.rows.filter(row=>row.status==='invalid'||row.status==='restricted_conflict').map(row=>row.index));
      legacyContactSync.mark(pending.filter((_,index)=>!failed.has(index)).map(row=>row.localContactId),'synced');
      if (failed.size) legacyContactSync.mark(pending.filter((_,index)=>failed.has(index)).map(row=>row.localContactId),'failed','中心拒绝旧联系人导入');
      await sync.sync();
      await flushLegacyMail();
    } catch (error) {
      legacyContactSync.defer(legacyContactSync.pending().map(row=>row.localContactId),error instanceof Error ? error.message : '旧联系人同步失败');
      Log.warn('legacy.contactSync','旧联系人同步失败，保留本地重试');
    } finally { legacySyncBusy=false; }
  };
  const flushLegacyMail=async():Promise<void>=>{
    if (!adapter.isOnline() || !adapter.legacyPersonalImportAllowed()) return;
    legacyMailSync.enqueueMapped();
    for (const item of legacyMailSync.pending()) {
      const result=await adapter.requestLive('POST',CONTACT_MAIL_ROUTE,item.payload);
      if (result.ok) legacyMailSync.mark(item.eventKey,'synced');
      else if (result.error.code==='UNAVAILABLE') legacyMailSync.defer(item.eventKey,result.error.message);
      else legacyMailSync.mark(item.eventKey,'failed',result.error.message);
    }
  };
  let stopped=false;
  const lifecycleRevisions=new Map<string,number>();
  const lifecycleKey=(ctx:ContactMirrorContext,ref:CenterContactRef)=>JSON.stringify([ctx.baseUrl,ctx.userId,ctx.permissionKey,ref.customerId,ref.contactId]);
  const revision=(ctx:ContactMirrorContext,ref:CenterContactRef)=>lifecycleRevisions.get(lifecycleKey(ctx,ref))??0;
  const invalidateContact=(ctx:ContactMirrorContext,ref:CenterContactRef)=>lifecycleRevisions.set(lifecycleKey(ctx,ref),revision(ctx,ref)+1);
  const changedAccess=(left:CenterContact|undefined,right:CenterContact|undefined)=>!left||!right||contactAccessFingerprint(contactDetailSnapshot(left))!==contactAccessFingerprint(contactDetailSnapshot(right));
  const saveDetail=(ctx:ContactMirrorContext,detail:CenterContactDetail)=>{
    const before=mirror.store.contact(ctx,detail.contact);mirror.store.saveDetail(ctx,detail);
    const accepted=mirror.store.contact(ctx,detail.contact);
    if(changedAccess(before,accepted))invalidateContact(ctx,detail.contact);
  };
  let flushTimer:ReturnType<typeof setTimeout>|undefined;
  const context=()=>stopped?null:adapter.contactReadContext();
  let matchContactsCache:{key:string;expiresAt:number;rows:CenterContact[]}|undefined;
  let matchContactsForceLive=false;
  const clearMatchContactsCache=()=>{matchContactsCache=undefined;};
  const invalidateMatchContacts=()=>{clearMatchContactsCache();matchContactsForceLive=true;};
  const matchContextActive=(ctx:ContactMirrorContext)=>{
    const current=context();
    return !!current&&current.userId===ctx.userId&&current.baseUrl===ctx.baseUrl&&current.permissionKey===ctx.permissionKey;
  };
  const liveMatchContacts=async(ctx:ContactMirrorContext):Promise<CenterContact[]>=>{
    const key=JSON.stringify([ctx.baseUrl,ctx.userId,ctx.permissionKey]);
    if(matchContactsCache?.key===key&&matchContactsCache.expiresAt>Date.now())return matchContactsCache.rows;
    const result=await readAllCenterContactsForMatch(input=>adapter.contacts(input),()=>matchContextActive(ctx));
    if(!result.ok)throw new Error(result.error.message);
    if(!matchContextActive(ctx))throw new Error('账号已切换');
    matchContactsCache={key,expiresAt:Date.now()+MATCH_CONTACTS_CACHE_TTL_MS,rows:result.data};
    return result.data;
  };
  const sync=createContactMailSyncService({
    context,online:()=>!stopped&&adapter.isOnline(),
    query:async input=>{
      const captured=context();const result=await adapter.requestLive<import('../../../server/core/center-contacts').CenterContactPage>('GET',centerContactPath(input));
      if(!result.ok&&['FORBIDDEN','UNAUTHORIZED'].includes(result.error.code)&&captured?.active()){for(const row of mirror.store.contacts(captured))invalidateContact(captured,row);mirror.store.invalidateContacts(captured);}
      return result;
    },
    post:input=>{
      const {sendAuthorizationId,smtpAcceptance,...event}=input;
      return sendAuthorizationId
        ?adapter.request('POST',SEND_ACCEPTANCE_ROUTES.accept,{authorizationId:sendAuthorizationId,event:smtpAcceptance??event,...(smtpAcceptance?{observedEvent:event}:{})},true)
        :adapter.request('POST',CONTACT_MAIL_ROUTE,event,true);
    },
    replace:(ctx,rows)=>{
      clearMatchContactsCache();
      matchContactsForceLive=false;
      const previous=mirror.store.contacts(ctx),next=new Map(rows.map(row=>[lifecycleKey(ctx,row),row])),old=new Map(previous.map(row=>[lifecycleKey(ctx,row),row]));
      mirror.store.replaceContacts(ctx,rows);
      legacyContactMap.reconcile(rows, new Date().toISOString());
      void flushLegacyContacts();
      for(const row of previous)if(changedAccess(row,next.get(lifecycleKey(ctx,row))))invalidateContact(ctx,row);
      for(const row of rows)if(!old.has(lifecycleKey(ctx,row)))invalidateContact(ctx,row);
    },
    contains:(ctx,row)=>mirror.store.ready(ctx)&&!!mirror.store.contact(ctx,row),
    upsert:(ctx,rows)=>{
      const before=new Map(mirror.store.contacts(ctx).map(row=>[row.contactId,row]));mirror.store.upsertContacts(ctx,rows);
      for(const row of rows)if(changedAccess(before.get(row.contactId),mirror.store.contact(ctx,row)))invalidateContact(ctx,row);
    },
    pending:ctx=>mirror.store.pendingEvents(ctx),
    blockEvent:(ctx,key,message)=>{mirror.store.failEvent(ctx,key,message);Log.warn('contact.mailSync','邮件同步权限已变化，原记录已保留在本地待核对');},
    acknowledge:(ctx,key,event)=>{
      if(event&&!event.correction&&(event.kind==='replied'||event.kind==='bounced'||event.kind==='autoreply'))onContactSignal(event.contactId,event.kind==='bounced'?'bounce':event.kind,{contactId:event.contactId,customerId:event.customerId},JSON.stringify([ctx.baseUrl,ctx.userId]));
      mirror.store.acknowledgeEvent(ctx,key,event);
    },
    reconcile:async()=>{
      const corrections=await replayInboxCenterClassificationChanges();if(!corrections.success)Log.warn('inbox.classification',corrections.error);
      let afterId=0;const captured=context();
      while(captured&&captured.active()&&context()?.permissionKey===captured.permissionKey) {
        const page=await reconcileInboxCenterContacts({afterId,limit:RECONCILE_PAGE_SIZE});
        if(!page.success)return failure('DATABASE_ERROR',page.error);
        if(!page.data.hasMore)return success(undefined);
        if(page.data.nextAfterId<=afterId)return failure('DATABASE_ERROR','邮件补挂游标未推进');
        afterId=page.data.nextAfterId;
      }
      return failure('UNAUTHORIZED','账号已切换');
    },
    report:error=>Log.error('contact.mailSync','本地邮件同步失败',error instanceof Error?error.stack:undefined),
    incremental: {
      store: {
        state: ctx => mirror.store.incrementalState?.(ctx) ?? { cursor: null, permissionKey: ctx.permissionKey ?? '' },
        upsert: (ctx, contact) => {
          const before = mirror.store.contact(ctx, contact);
          mirror.store.upsertContacts(ctx, [contact]);
          const current = mirror.store.contact(ctx, contact);
          if (changedAccess(before, current)) invalidateContact(ctx, contact);
        },
        remove: (ctx, reference) => {
          mirror.store.forgetContact(ctx, reference);
          invalidateContact(ctx, reference);
        },
        saveCursor: (ctx, cursor) => mirror.store.saveIncrementalCursor?.(ctx, cursor),
        invalidate: ctx => {
          clearMatchContactsCache();
          mirror.store.invalidateContacts(ctx);
          sync.invalidate(ctx);
        },
      },
      fetchPage: async cursor => {
        const captured = context();
        if (!captured) return undefined;
        const after = cursor ?? '0';
        const result = await adapter.requestLive<ContactChangePage>('GET', `${CONTACT_CHANGE_ROUTE}?after=${encodeURIComponent(after)}&limit=100`);
        if (!result.ok || !captured.active?.() || context()?.userId !== captured.userId) return undefined;
        return {
          baseCursor: cursor,
          nextCursor: result.data.nextCursor,
          hasMore: result.data.hasMore,
          resyncRequired: result.data.resyncRequired,
          changes: result.data.items.map(item => item.kind === 'upsert' && item.contact
            ? { kind: 'upsert' as const, contact: item.contact }
            : { kind: 'tombstone' as const, contactId: item.contactId, customerId: item.customerId }),
        } satisfies ContactIncrementalPage;
      },
      head: async () => {
        const captured = context();
        if (!captured) return undefined;
        const result = await adapter.requestLive<ContactChangePage>('GET', `${CONTACT_CHANGE_ROUTE}?after=0&limit=1`);
        return result.ok && captured.active?.() && context()?.userId === captured.userId ? result.data.headCursor : undefined;
      },
      reconcile: async () => {
        const corrections = await replayInboxCenterClassificationChanges();
        if (!corrections.success) Log.warn('inbox.classification', corrections.error);
        return success(undefined);
      },
    },
  });
  const reader=createContactLocalReadService({context,ready:ctx=>mirror.store.ready(ctx),contacts:ctx=>mirror.store.contacts(ctx),page:(ctx,query)=>mirror.store.page(ctx,query),refresh:()=>sync.sync(),report:error=>Log.error('contact.localRead','联系人本地读取失败',error instanceof Error?error.stack:undefined)});
  adapter.setContactReader(query=>reader.read(query));
  const detailReader=createContactDetailReadService({
    revision,
    context,ready:ctx=>mirror.store.ready(ctx),contact:(ctx,ref)=>mirror.store.contact(ctx,ref),detail:(ctx,ref)=>mirror.store.detail(ctx,ref),
    save:(ctx,detail)=>{saveDetail(ctx,detail);sync.observe(ctx,{contact:mirror.store.contact(ctx,detail.contact)});},
    forget:(ctx,ref)=>{mirror.store.forgetContact(ctx,ref);invalidateContact(ctx,ref);sync.invalidate(ctx);changed();},
    fetch:ref=>adapter.requestLive<CenterContactDetail>('GET',`${CONTACT_ASSIGNMENT_ROUTES.contact}/${encodeURIComponent(String(ref.contactId))}?customerId=${encodeURIComponent(ref.customerId)}`),
    refresh:()=>sync.sync(),report:error=>Log.error('contact.detailRead','联系人详情读取失败',error instanceof Error?error.stack:undefined),
  });
  const commands=createContactCommandService({
    context,
    revision,
    store:{list:ctx=>mirror.store.commandRows(ctx),unresolved:ctx=>mirror.store.unresolvedCommands(ctx),get:(ctx,id)=>mirror.store.getCommand(ctx,id),confirmed:(ctx,id)=>mirror.store.commandConfirmed(ctx,id),duplicate:(ctx,action,input)=>mirror.store.findCommandDuplicate(ctx,action,input),maintain:(ctx,now)=>mirror.store.maintainCommands(ctx,now),put:(ctx,row)=>mirror.store.putCommand(ctx,row),remove:(ctx,id)=>mirror.store.removeCommand(ctx,id),transaction:(ctx,work)=>mirror.store.commandTransaction(ctx,work)},
    detail:(ctx,ref)=>{
      if(!mirror.store.ready(ctx))return undefined;
      const row=mirror.store.contact(ctx,ref);return row?contactDetailSnapshot(row,mirror.store.detail(ctx,ref)):undefined;
    },
    send:(action,input)=>adapter.requestLive<CenterContactDetail>('POST',`${CONTACT_ASSIGNMENT_ROUTES.contact}/${encodeURIComponent(String(input.contactId))}/${action}`,input),
    refresh:ref=>adapter.requestLive<CenterContactDetail>('GET',`${CONTACT_ASSIGNMENT_ROUTES.contact}/${encodeURIComponent(String(ref.contactId))}?customerId=${encodeURIComponent(ref.customerId)}`),
    save:(ctx,detail)=>{
      saveDetail(ctx,detail);sync.observe(ctx,detail);
      changed();
    },
    forget:(ctx,ref)=>{mirror.store.forgetContact(ctx,ref);invalidateContact(ctx,ref);sync.invalidate(ctx);changed();},
    key:randomUUID,now:()=>new Date().toISOString(),
    report:error=>Log.error('contact.commands','联系人修改同步失败',error instanceof Error?error.stack:undefined),
  });
  adapter.setDetailReader(async ref=>{
    const captured=context();const result=await detailReader.read(ref);
    if(!result.ok)return result;
    if(!captured?.active())return failure('UNAUTHORIZED','账号已切换');
    return success(commands.detail(captured,result.data));
  });
  adapter.setContactWriter(commands);
  adapter.setContactSync(commands);
  setAgentContactPort({
    snapshot: () => {
      try {
        const ctx = context();
        if (!ctx || !ctx.active()) return failure('UNAUTHORIZED', '请登录中心账号');
        if (!mirror.store.ready(ctx)) return failure('UNAVAILABLE', '联系人正在同步');
        return success({ scope: JSON.stringify([ctx.baseUrl, ctx.userId, ctx.permissionKey]), active: ctx.active, contacts: mirror.store.contacts(ctx), notes: mirror.store.contacts(ctx).flatMap(row => (mirror.store.detail(ctx, row)?.activities ?? []).map(activity => ({ contactId: row.contactId, customerId: row.customerId, note: activity.note }))) });
      } catch (error) {
        Log.error('agent.contact', '授权联系人读取失败', error instanceof Error ? error.stack : undefined);
        return failure('DATABASE_ERROR', '联系人暂时无法读取');
      }
    },
    createKey: randomUUID,
    now: Date.now,
    report: error => Log.error('agent.contact', '中心联系人操作未收到确认', error instanceof Error ? error.stack : undefined),
    update:input=>adapter.contactUpdate(input),
    followup:input=>adapter.contactFollowup(input),
    importRows:input=>adapter.request('POST',LEAD_ROUTES.imports,input,true),
    tasks:input=>adapter.requestLive('GET',`${TASK_ROUTES.tasks}?${new URLSearchParams({status:'open',limit:String(input.limit),offset:String(input.offset)})}`),
  });
  const report=(result:Awaited<ReturnType<typeof sync.sync>>)=>{
    if(result.ok)changed();else if(result.error.code!=='UNAUTHORIZED')Log.warn('contact.mailSync',result.error.message);
  };
  const scheduleFlush=()=>{
    if(stopped||flushTimer)return;
    flushTimer=setTimeout(()=>{flushTimer=undefined;void centerSender.replay(false).then(()=>sync.flush()).then(result=>{report(result);if(result.ok)return centerSender.replay(false);});},MAIL_FLUSH_DELAY_MS);
  };
  const centerSender=bindCenterSendRuntime(adapter,mirror.store,changed,scheduleFlush,ctx=>sync.invalidate(ctx));
  setInboxCenterContactPort({
    context,
    contacts:ctx=>mirror.store.ready(ctx)&&!matchContactsForceLive?mirror.store.contacts(ctx):liveMatchContacts(ctx),
    findByEmail:async(ctx,email)=>{
      const rows=mirror.store.ready(ctx)&&!matchContactsForceLive?mirror.store.findByEmail(ctx,email):await liveMatchContacts(ctx);
      const normalized=email.trim().toLowerCase();
      return rows.filter(row=>row.email?.trim().toLowerCase()===normalized);
    },
    getLinks:(ctx,id)=>mirror.store.linksForLocalMessage(ctx,id).flatMap(link=>{
      const row=mirror.store.ready(ctx)?mirror.store.contact(ctx,link):undefined;return row?[{...link,status:centerContactDisplayStatus(row),tags:row.relationshipStage?row.relationshipStage==='cold'?[]:[row.relationshipStage]:row.tags,email:row.email??undefined,companyName:row.companyName,contactVersion:row.contactVersion,canDelete:row.canDelete}]:[];
    }),
    storeMail:(ctx,input)=>{
      try {
        const current=context();if(!current?.active()||current.userId!==ctx.userId||current.baseUrl!==ctx.baseUrl||current.permissionKey!==ctx.permissionKey)return failResult('账号或权限已变化');
        const source=readMailboxSnapshot(input.localMessageId);if(!source)return failResult('邮件不存在');
        const contact=mirror.store.contact(ctx,input.event);
        if(!mirror.store.ready(ctx)||!contact)return failResult('联系人不在当前授权副本中');
        const writable=canSendToContact(contact)&&input.recordEvent!==false;
        mirror.store.linkMail(ctx,{messageKey:input.event.messageKey,localMailId:source.id,mailAccountId:source.accountId,
          mailbox:input.event.mailboxKey,contactId:input.event.contactId,customerId:input.event.customerId,role:input.role,...(writable?{event:input.event}:{})});
        if(writable)scheduleFlush();return okResult(undefined);
      }catch(error){Log.error('contact.mailLink','本地邮件关联保存失败',error instanceof Error?error.stack:undefined);return failResult('本地邮件关联未保存');}
    },
  });
  const observe=adapter.onResponse((ctx,method,path,data)=>{
    if(method!=='GET'&&path.startsWith('/api/crm/')){
      invalidateMatchContacts();
      const current=context();if(!current||current.userId!==ctx.userId||current.baseUrl!==ctx.baseUrl)return;
      if(path.startsWith('/api/crm/contact-shares'))sync.invalidate(current);
      // Command receipts are persisted only after the command service checks its captured authorization.
      const commandReceipt=/^\/api\/crm\/contacts\/\d+\/(update|followups)$/.test(path);
      const returned=data&&typeof data==='object'&&'contact' in data?(data as {contact:CenterContact}).contact:undefined;
      const existing=returned?mirror.store.contact(current,returned):undefined;
      const currentAccess=returned&&existing&&!changedAccess(existing,returned);
      if(!commandReceipt&&currentAccess&&data&&typeof data==='object'&&'company' in data&&'activities' in data)saveDetail(current,data as CenterContactDetail);
      if(path==='/api/crm/contacts/delete'&&data&&typeof data==='object'&&'deleted' in data){
        sync.invalidate(current);
        for(const ref of (data as import('../../../server/core/crm-lifecycle').ContactDeleteReceipt).deleted){mirror.store.forgetContact(current,ref);invalidateContact(current,ref);}
        changed();
      }
      if(!commandReceipt&&currentAccess)sync.observe(current,data);
      // Archival acknowledgments intentionally contain no contact snapshot.
      // Re-read the authorized list rather than inserting data from a revoked receipt.
      if(path===SEND_ACCEPTANCE_ROUTES.accept){sync.invalidate(current);void sync.sync().then(report);}
      if(!commandReceipt&&/^\/api\/crm\/(contacts|contact-assignments|contact-shares|imports|leads)(?:[/?]|$)/.test(path))void sync.sync().then(report);
    }
  });
  const timer=setInterval(()=>{void centerSender.replay();void replayInboxCenterClassificationChanges();if(adapter.isOnline())void sync.sync().then(report);},REFRESH_INTERVAL_MS);
  const commandTimer=setInterval(()=>{if(adapter.isOnline())void commands.sync().then(report);},OFFLINE_CRM_LIMITS.sync_interval_seconds*MILLISECONDS_PER_SECOND);
  void sync.sync().then(report);
  return {refresh:()=>sync.sync(),close(){stopped=true;centerSender.close();clearInterval(timer);clearInterval(commandTimer);if(flushTimer)clearTimeout(flushTimer);observe();adapter.setContactReader(undefined);adapter.setDetailReader(undefined);adapter.setContactWriter(undefined);adapter.setContactSync(undefined);setAgentContactPort(null);setInboxCenterContactPort(null);mirror.close();}};
}
