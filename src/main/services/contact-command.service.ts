import { failure, success, type Result, type ErrorCode } from '../../../server/core/crm';
import type { CenterContactDetail, CenterContactRef, CenterContactFollowup, CenterContactUpdate } from '../../../server/core/contact-assignments';
import { contactUpdate, contactFollowup } from '../../../server/services/contact-assignments';
import type { CrmSyncResolve, CrmSyncStatus } from '../../shared/online-crm';
import type { ContactMirrorContext } from '../core/contact-mirror';
import { CONTACT_COMMAND_LIMITS, CONTACT_COMMAND_PREFIX, contactAccessFingerprint, contactCommandAllowed as allowed, contactCommandDetail, contactCommandFingerprint, sameContact, type ContactCommandAction, type ContactCommandInput, type ContactCommandContext, type ContactCommandRow, type ContactCommandStore } from '../core/contact-commands';
export interface ContactCommandPort {
 context(): ContactCommandContext | null;
 revision?(ctx: ContactMirrorContext, ref: CenterContactRef): number;
 store: ContactCommandStore;
 detail(ctx: ContactMirrorContext, ref: CenterContactRef): CenterContactDetail | undefined;
 send(action: ContactCommandAction, input: ContactCommandInput): Promise<Result<CenterContactDetail>>;
 refresh(ref: CenterContactRef): Promise<Result<CenterContactDetail>>;
 save(ctx: ContactMirrorContext, detail: CenterContactDetail): void;
 forget(ctx: ContactMirrorContext, ref: CenterContactRef): void;
 key(): string; now(): string; report(error: unknown): void;
}
/** Durable commands use injected storage/network ports; this service performs no IO itself. */
export function createContactCommandService(port: ContactCommandPort) {
 let running:Promise<Result<void>>|null=null;
 const unavailable = () => failure('UNAUTHORIZED','账号或权限已变化');
 const read = (ctx:ContactMirrorContext) => port.store.unresolved?.(ctx) ?? port.store.list(ctx);
 const get=(ctx:ContactMirrorContext,id:string)=>port.store.get?port.store.get(ctx,id):read(ctx).find(row=>row.id===id);
 const isConfirmed=(ctx:ContactMirrorContext,id:string)=>port.store.confirmed?port.store.confirmed(ctx,id):read(ctx).some(row=>row.id===id&&row.status==='confirmed');
 const duplicate=(ctx:ContactMirrorContext,action:ContactCommandAction,input:ContactCommandInput)=>{
  if(port.store.duplicate)return port.store.duplicate(ctx,action,input);
  const row=read(ctx).find(item=>item.input.idempotencyKey===input.idempotencyKey||item.id===`${CONTACT_COMMAND_PREFIX}${input.idempotencyKey}`||item.retiredKeys?.includes(input.idempotencyKey));
  return row?{matches:row.action===action&&contactCommandFingerprint(row.input)===contactCommandFingerprint(input),confirmed:row.status==='confirmed',row}:undefined;
 };
 function projection(ctx:ContactMirrorContext, confirmed:CenterContactDetail) { return contactCommandDetail(confirmed,read(ctx)); }
 const transaction=(ctx:ContactMirrorContext,work:()=>void)=>port.store.transaction?port.store.transaction(ctx,work):work();
 const matches=(a:ContactCommandRow|undefined,b:ContactCommandRow)=>a?.status==='pending'&&a.action===b.action&&contactCommandFingerprint(a.input)===contactCommandFingerprint(b.input);
 function terminal(ctx:ContactCommandContext,row:ContactCommandRow,message:string,forget=false,rejected=false,code:ErrorCode='FORBIDDEN') {
  port.store.put(ctx,{...row,status:'failed',error:message,errorCode:code,discardable:rejected||!row.attempted});
  if (forget) port.forget(ctx,row.input);
 }
 async function flush(ctx:ContactCommandContext):Promise<Result<void>> {
  try {
   port.store.maintain?.(ctx,port.now());
   let sent=0;
   for (const selected of read(ctx)) {
    const row=get(ctx,selected.id);if(!row)continue;
    if (!ctx.active()) return unavailable();
    if (!ctx.online() || sent>=CONTACT_COMMAND_LIMITS.batch) break;
    if (row.status!=='pending') continue;
    if (row.predecessorId && !isConfirmed(ctx,row.predecessorId)) continue;
    const base=port.detail(ctx,row.input);
    if (!base || !allowed(base,row.action,row.input)) {transaction(ctx,()=>{if(matches(get(ctx,row.id),row))terminal(ctx,row,'联系人权限已变化',!base);});continue;}
    const access=contactAccessFingerprint(base);
    const revision=port.revision?.(ctx,row.input);
    // Once attempted, the wire is immutable, even if the local projection acquired a newer center version.
    let attempted:ContactCommandRow|undefined;
    transaction(ctx,()=>{
     const current=get(ctx,row.id);
     if(!ctx.active()||!matches(current,row))return;
     if(row.predecessorId && !isConfirmed(ctx,row.predecessorId))return;
     attempted={...row,attempted:true};port.store.put(ctx,attempted);
    });
    if(!attempted)continue;
    let result:Result<CenterContactDetail>;
    try { result=await port.send(row.action,structuredClone(row.input)); }
    catch(error) {port.report(error);transaction(ctx,()=>{if(ctx.active()&&matches(get(ctx,row.id),row))port.store.put(ctx,{...attempted!,error:'连接中断，等待确认'});});break;}
    sent++;
    if (!ctx.active()) return unavailable();
    let conflicted:ContactCommandRow|undefined,stop=false;
    transaction(ctx,()=>{
     if(!ctx.active()||!matches(get(ctx,row.id),row))return;
     if(result.ok){
      if(!sameContact(result.data.contact,row.input)){port.store.put(ctx,{...attempted!,error:'中心回执关联不一致，等待确认'});stop=true;return;}
      const currentDetail=port.detail(ctx,row.input);
      if(!currentDetail||port.revision?.(ctx,row.input)!==revision||contactAccessFingerprint(currentDetail)!==access||!allowed(currentDetail,row.action,row.input)){terminal(ctx,attempted!,'联系人归属或权限已变化',!currentDetail);return;}
      port.save(ctx,result.data);port.store.put(ctx,{...attempted!,status:'confirmed',confirmedAt:port.now(),error:undefined});return;
     }
     const {code,message}=result.error;
     if(code==='CONFLICT'){conflicted={...attempted!,status:'conflict',error:message};port.store.put(ctx,conflicted);}
     else if(['FORBIDDEN','NOT_FOUND','UNAUTHORIZED','PASSWORD_CHANGE_REQUIRED','INVALID_INPUT','PAYLOAD_TOO_LARGE'].includes(code))terminal(ctx,attempted!,message,['FORBIDDEN','NOT_FOUND','UNAUTHORIZED','PASSWORD_CHANGE_REQUIRED'].includes(code),!row.attempted,code);
     else{port.store.put(ctx,{...attempted!,error:message});stop=true;}
    });
    if(stop)break;
    if(conflicted){
     const latest=await port.refresh(row.input);if(!ctx.active())return unavailable();
     transaction(ctx,()=>{
      const current=get(ctx,row.id);
      if(!ctx.active()||!current||contactCommandFingerprint(current)!==contactCommandFingerprint(conflicted))return;
      const currentDetail=port.detail(ctx,row.input);
      if(!currentDetail||port.revision?.(ctx,row.input)!==revision||contactAccessFingerprint(currentDetail)!==access){terminal(ctx,current,'联系人归属或权限已变化',!currentDetail);return;}
      if(latest.ok&&sameContact(latest.data.contact,row.input))port.save(ctx,latest.data);
      else if(!latest.ok&&['FORBIDDEN','NOT_FOUND','UNAUTHORIZED'].includes(latest.error.code))terminal(ctx,current,latest.error.message,true,true,latest.error.code);
     });
    }
   }
   return success(undefined);
  } catch(error) {port.report(error);return failure('DATABASE_ERROR','同步回执保存失败，待确认记录已保留');}
 }
 function sync():Promise<Result<void>> {
  if(running)return running;
  const ctx=port.context();if(!ctx || !ctx.active())return Promise.resolve(unavailable());
  running=flush(ctx).finally(()=>{running=null;});return running;
 }
 async function write(action:ContactCommandAction,value:unknown):Promise<Result<CenterContactDetail>> {
  const parsed=action==='update'?contactUpdate(value):contactFollowup(value);if(!parsed.ok)return parsed;
  const ctx=port.context();if(!ctx || !ctx.active())return unavailable();
  try {
   const input=structuredClone(parsed.data), rows=read(ctx);
   const prior=duplicate(ctx,action,input);
   if(prior && !prior.matches)return failure('CONFLICT','保存标识已用于其他内容');
   const confirmed=port.detail(ctx,input);if(!confirmed)return failure('NOT_FOUND','联系人不在当前授权范围');
   if(!allowed(confirmed,action,input))return failure('FORBIDDEN','没有所选字段或跟进的修改权限');
   if(prior?.row?.status==='failed')return failure(prior.row.errorCode??'FORBIDDEN',prior.row.error??'此修改未被接受');
   if(prior) return success(projection(ctx,confirmed));
   const chain=rows.filter(row=>sameContact(row.input,input) && row.status!=='confirmed');
   if(chain.some(row=>row.status!=='pending'))return failure('CONFLICT','请先处理此联系人的同步冲突');
   const draft=projection(ctx,confirmed);
   if(input.expectedVersion!==draft.contact.contactVersion)return failure('CONFLICT','联系人版本已变化，请重新打开详情');
   const predecessor=chain.at(-1);
   const id=`${CONTACT_COMMAND_PREFIX}${input.idempotencyKey}`;
   let changed=false;
   transaction(ctx,()=>{
    if(!ctx.active()||duplicate(ctx,action,input)||contactCommandFingerprint(read(ctx))!==contactCommandFingerprint(rows)){changed=true;return;}
    port.store.put(ctx,{id,action,input,status:'pending',createdAt:port.now(),...(predecessor?{predecessorId:predecessor.id}:{})});
   });
   if(changed)return failure('CONFLICT','同步记录已变化，请重新核对');
   if(ctx.online())await sync();
   if(!ctx.active())return unavailable();
   const persisted=get(ctx,id);
   if(persisted?.status==='failed')return failure(persisted.errorCode??'FORBIDDEN',persisted.error??'此修改未被接受');
   const latest=port.detail(ctx,input);if(!latest)return failure('FORBIDDEN','联系人已移出当前授权范围');
   return success(projection(ctx,latest));
  } catch(error) {port.report(error);return failure('DATABASE_ERROR','本地保存未完成，请重试');}
 }
 function status():Pick<CrmSyncStatus,'pending'|'failed'|'conflicts'|'issues'|'syncing'|'lastError'> {
  const ctx=port.context();const rows=ctx?.active()?read(ctx):[];
  return {syncing:running!==null,lastError:rows.find(row=>row.status!=='confirmed'&&row.error)?.error,pending:rows.filter(x=>x.status==='pending').length,failed:rows.filter(x=>x.status==='failed').length,conflicts:rows.filter(x=>x.status==='conflict').length,
   issues:rows.filter(x=>x.status==='failed'||x.status==='conflict').map(row=>{
    const current=ctx ? port.detail(ctx,row.input) : undefined;
    const group=[row];const ids=new Set([row.id]);
    for(const item of rows)if(item.predecessorId&&ids.has(item.predecessorId)){group.push(item);ids.add(item.id);}
    const visible=current && group.every(item=>allowed(current,item.action,item.input));
    const fields=Object.assign({},...group.filter(item=>item.action==='update').map(item=>(item.input as CenterContactUpdate).fields)) as Record<string,unknown>;
    const note=group.filter(item=>item.action==='followups').map(item=>(item.input as CenterContactFollowup).note).join('\n');
    const central=current;
    const centralFields=Object.keys(fields).length && central ? Object.fromEntries(Object.keys(fields).map(field=>[field,field==='preferences'?central.contact.extra?.preferences:(central.contact as unknown as Record<string,unknown>)[field]])) : undefined;
    return {id:row.id,customerId:row.input.customerId,status:row.status as 'failed'|'conflict',message:row.error??'联系人同步未完成',
     ...(visible?{contact:{contactId:row.input.contactId,customerId:row.input.customerId,name:[current.contact.firstName,current.contact.lastName].filter(Boolean).join(' ')||current.contact.email||'联系人',action:row.action,...(Object.keys(fields).length?{fields,centralFields}:{}),...(note?{note}:{})}}:{})};
   })};
 }
 async function resolve(input:CrmSyncResolve):Promise<Result<void>> {
  const ctx=port.context();if(!ctx || !ctx.active())return unavailable();
  try {
   if(running)return failure('CONFLICT','正在同步，请稍后重试');
   const rows=read(ctx),row=rows.find(x=>x.id===input.id);if(!row)return failure('NOT_FOUND','同步记录不存在');
   if(row.status==='pending')return failure('CONFLICT','该记录尚待中心确认，请连接后同步');
   if(row.status==='confirmed')return failure('CONFLICT','此记录已确认');
   const descendants:ContactCommandRow[]=[];let parentIds=new Set([row.id]);
   for(const item of rows)if(item.predecessorId && parentIds.has(item.predecessorId)){descendants.push(item);parentIds.add(item.id);}
   if(input.action==='use-central'){
    let discarded=false;
    transaction(ctx,()=>{
     const fresh=read(ctx),current=fresh.find(item=>item.id===row.id);
     if(!ctx.active()||!current||(current.status!=='conflict'&&!(current.status==='failed'&&current.discardable)))return;
     if(contactCommandFingerprint(current)!==contactCommandFingerprint(row))return;
     const group:ContactCommandRow[]=[];const ids=new Set([row.id]);
     for(const item of fresh)if(item.predecessorId&&ids.has(item.predecessorId)){group.push(item);ids.add(item.id);}
     if(group.some(item=>item.attempted))return;
     for(const item of group.reverse())port.store.remove(ctx,item.id);port.store.remove(ctx,row.id);discarded=true;
    });
    return discarded?success(undefined):failure('CONFLICT','此记录不能安全放弃');
   }
   if(input.action!=='retry' || row.status!=='conflict')return failure('FORBIDDEN','此记录不能自动重试');
   if(descendants.some(item=>item.status!=='pending'||item.attempted) || descendants.length && !port.store.transaction)return failure('CONFLICT','后续修改尚不能安全重试，请保留或放弃整组修改');
   if(!ctx.online())return failure('UNAVAILABLE','请连接中心后重试');
   const before=port.detail(ctx,row.input),revision=port.revision?.(ctx,row.input);
   const access=before?contactAccessFingerprint(before):undefined;
   const latest=await port.refresh(row.input);if(!ctx.active())return unavailable();
   const currentDetail=port.detail(ctx,row.input);
   if(!currentDetail||port.revision?.(ctx,row.input)!==revision||contactAccessFingerprint(currentDetail)!==access){terminal(ctx,row,'联系人归属或权限已变化',!currentDetail);return failure('FORBIDDEN','联系人归属或权限已变化');}
   if(!latest.ok){if(['FORBIDDEN','NOT_FOUND','UNAUTHORIZED'].includes(latest.error.code))terminal(ctx,row,latest.error.message,true);return latest;}
   if(!sameContact(latest.data.contact,row.input))return failure('CONFLICT','联系人关联已变化');
   const group=[row,...descendants];
   if(group.some(item=>!allowed(latest.data,item.action,item.input))) {terminal(ctx,row,'联系人权限已变化');return failure('FORBIDDEN','联系人权限已变化');}
   const version=latest.data.contact.contactVersion;if(!version)return failure('CONFLICT','中心联系人版本无效');
   const keys=group.map(()=>port.key());
   if(new Set(keys).size!==keys.length || keys.some(key=>duplicate(ctx,row.action,{...row.input,idempotencyKey:key})))return failure('CONFLICT','保存标识重复，请重试');
   port.save(ctx,latest.data);
   // An explicit retry is the only rebase. Recheck the durable chain after refreshing permissions.
   let changed=false;
   const persist=()=>{
    const current=read(ctx).filter(item=>sameContact(item.input,row.input));
    const previous=rows.filter(item=>sameContact(item.input,row.input));
    if(!ctx.active() || keys.some(key=>duplicate(ctx,row.action,{...row.input,idempotencyKey:key})) || contactCommandFingerprint(current)!==contactCommandFingerprint(previous)){changed=true;return;}
    group.forEach((item,index)=>port.store.put(ctx,{...item,input:{...item.input,expectedVersion:version+index,idempotencyKey:keys[index]!},retiredKeys:[...(item.retiredKeys??[]),item.input.idempotencyKey],history:[...(item.history??[]),structuredClone(item.input)],status:'pending',attempted:false,error:undefined,errorCode:undefined,discardable:undefined}));
   };
   if(port.store.transaction)port.store.transaction(ctx,persist);else persist();
   if(changed)return failure('CONFLICT','同步记录已变化，请重新核对');
   return success(undefined);
  }catch(error){port.report(error);return failure('DATABASE_ERROR','同步处理未完成，请重试');}
 }
 return {write,update:(input:unknown)=>write('update',input),followup:(input:unknown)=>write('followups',input),detail:projection,sync,status,resolve};
}
