import { failure, success, type Result } from '../../../server/core/crm';
import {hasContactedCustomer,customerBoardStage} from '../../../server/core/leads';
import type { LeadBootstrap, LeadDetail, LeadPage, LeadQuery, ImportReceipt } from '../../../server/core/leads';
import { LEAD_LIMITS } from '../../../server/core/leads';
import type { CrmSyncResolve, CrmSyncStatus } from '../../shared/online-crm';
import { OFFLINE_CRM_LIMITS, emptyOfflineCrmState, type CrmNetwork, type OfflineCrmContext, type OfflineCrmStore, type OfflineCrmState, type OfflineOperation } from '../core/offline-crm';
import { queueCrmMutation } from './offline-crm-mutations.service';

const unavailable = (result:Result<unknown>) => !result.ok && ['UNAVAILABLE','DATABASE_ERROR','RATE_LIMITED'].includes(result.error.code);
const accessKey = (bootstrap:LeadBootstrap) => JSON.stringify([bootstrap.userId,bootstrap.scope,[...bootstrap.capabilities].sort()]);
const scopeKey = (ctx:OfflineCrmContext) => JSON.stringify([ctx.baseUrl,ctx.userId,ctx.permissionKey]);
const MILLISECONDS_PER_SECOND = 1000;
const editablePath = (path:string) => path==='/api/crm/leads'||path==='/api/crm/imports'||/^\/api\/crm\/leads\/[^/]+\/(update|followups)$/.test(path);
const contactPath = (path:string) => /^\/api\/crm\/(contacts|contact-assignments|contact-mail-events)(?:[/?]|$)/.test(path);
const validDetail=(value:unknown):value is LeadDetail=>!!value&&typeof value==='object'&&typeof (value as LeadDetail).customerId==='string'&&Number.isSafeInteger((value as LeadDetail).version)&&(value as LeadDetail).version>0&&Array.isArray((value as LeadDetail).contacts)&&Array.isArray((value as LeadDetail).activities);
function validImport(value:unknown,count:number):value is ImportReceipt {
  if(!value||typeof value!=='object')return false;
  const receipt=value as ImportReceipt;
  return typeof receipt.batchId==='string'&&Number.isSafeInteger(receipt.version)&&Array.isArray(receipt.rows)&&receipt.rows.length===count&&new Set(receipt.rows.map(r=>r.index)).size===count&&receipt.rows.every(r=>Number.isSafeInteger(r.index)&&r.index>=0&&r.index<count&&typeof r.rowId==='string'&&['created','duplicate','invalid','restricted_conflict'].includes(r.status)&&(!['created','duplicate'].includes(r.status)||typeof r.customerId==='string'));
}
/** All IO is through ports. Each save is one durable projection+outbox transaction. */
export function createOfflineCrmService(store:OfflineCrmStore,uuid:()=>string,now:()=>string,report:(error:unknown)=>void=()=>{}) {
  const running = new Map<string,Promise<void>>();
  const mutations = new Map<string,Promise<unknown>>();
  const refreshing = new Set<string>();
  const contactRevisions = new Map<string,number>();
  const settle=(ctx:OfflineCrmContext)=>mutations.get(scopeKey(ctx))??Promise.resolve();
  const clone=<T>(value:T):T=>structuredClone(value);
  function load(ctx:OfflineCrmContext):OfflineCrmState {
    const state=store.load(ctx);
    if(state.permissionKey===ctx.permissionKey)return state;
    const cleared=emptyOfflineCrmState(ctx.permissionKey);
    cleared.outbox=state.outbox.map(op=>({...op,status:'failed',message:'账号权限已变化，请联网核对'}));
    store.save(ctx,cleared);return cleared;
  }
  function save(ctx:OfflineCrmContext,state:OfflineCrmState):boolean {
    if(!ctx.active())return false;
    store.save(ctx,state);return true;
  }
  function localRead(state:OfflineCrmState,path:string):Result<unknown> {
    const url=new URL(path,'http://local.invalid');
    if(url.pathname==='/api/crm/bootstrap')return state.bootstrap?success(clone(state.bootstrap)):failure('UNAVAILABLE','请先联网完成客户数据同步');
    if(url.pathname==='/api/crm/leads') {
      const view=(url.searchParams.get('view')??'mine') as LeadQuery['view'];
      if(!['personal','assigned','operations','pool','mine','all'].includes(view))return failure('INVALID_INPUT','客户范围无效');
      const limit=Number(url.searchParams.get('limit')??LEAD_LIMITS.page),offset=Number(url.searchParams.get('offset')??0);
      if(!Number.isSafeInteger(limit)||limit<1||limit>OFFLINE_CRM_LIMITS.pageSize||!Number.isSafeInteger(offset)||offset<0)return failure('INVALID_INPUT','分页参数无效');
      if(!state.bootstrap)return failure('UNAVAILABLE','请先联网完成客户数据同步');
      const membership=state.views[view]??(view==='mine'?[...(state.views.personal??[]),...(state.views.assigned??[])]:undefined);
      if(!membership)return failure('UNAVAILABLE','此客户范围尚未缓存，请联网同步');
      const staged=new Set(state.outbox.flatMap(op=>op.entities));
      const search=(url.searchParams.get('search')??'').trim().toLowerCase();
      const assignment=url.searchParams.get('assignment'),stage=url.searchParams.get('stage');
      const followupOnly=url.searchParams.get('followupOnly')==='true';
      if(url.searchParams.has('followupOnly')&&!['true','false'].includes(url.searchParams.get('followupOnly')!)||followupOnly&&view==='pool')return failure('INVALID_INPUT','列表参数无效');
      const items=Object.values(state.customers).filter(c=>{
        const pending=staged.has(c.customerId)&&((view==='personal'&&c.origin==='personal')||(view==='operations'&&c.origin==='operations')||view==='all'||view==='mine'&&c.ownerUserId===state.bootstrap!.userId);
        return (membership.includes(c.customerId)||pending)&&(!assignment||(assignment==='assigned'?!!c.ownerUserId:!c.ownerUserId))&&(!followupOnly||hasContactedCustomer(c.contacts))&&(!stage||(followupOnly?customerBoardStage({...c,hasContacted:hasContactedCustomer(c.contacts)}):c.stage??'cold')===stage)&&(!search||[c.companyName,c.country,...c.contacts.flatMap(ct=>[ct.name,ct.email])].some(value=>value?.toLowerCase().includes(search)));
      });
      return success({items:clone(items.slice(offset,offset+limit).map(c=>({...c,hasContacted:hasContactedCustomer(c.contacts)}))),total:items.length});
    }
    const detail=/^\/api\/crm\/leads\/([^/]+)$/.exec(url.pathname);
    if(detail){const id=state.aliases[detail[1]!]??detail[1]!;return state.customers[id]&&(state.customers[id]!.customerKey||state.cache[`detail:${id}`])?success(clone(state.customers[id])):failure('NOT_FOUND','本地没有此客户详情，请联网同步');}
    return Object.prototype.hasOwnProperty.call(state.cache,path)?success(clone(state.cache[path])):failure('UNAVAILABLE','此内容尚未缓存，请联网加载');
  }
  function absorb(state:OfflineCrmState,path:string,data:unknown) {
    const url=new URL(path,'http://local.invalid');
    if(url.pathname==='/api/crm/bootstrap') {
      const next=data as LeadBootstrap;
      if(state.bootstrap&&accessKey(state.bootstrap)!==accessKey(next)){
        state.customers={};state.views={};state.cache={};state.receipts={};
        state.outbox.forEach(op=>{op.status='failed';op.message='客户权限范围已变化，请核对后处理';op.central=undefined;});
      }
      state.bootstrap=clone(next);
    } else if(url.pathname==='/api/crm/leads') {
      const view=(url.searchParams.get('view')??'mine') as LeadQuery['view'];
      state.views[view]=[...new Set([...(state.views[view]??[]),...(data as LeadPage).items.map(c=>c.customerId)])];
      for(const c of (data as LeadPage).items)if(!state.customers[c.customerId]&&!state.outbox.some(op=>op.entities.includes(c.customerId)))state.customers[c.customerId]={...c,source:c.source??'',sourceDetail:'',customerKey:'',ownerUserId:c.ownerUserId??null,contacts:[],activities:[]};
    } else if(/^\/api\/crm\/leads\/[^/]+$/.test(url.pathname)) {
      const detail=data as LeadDetail;
      state.cache[`detail:${detail.customerId}`]=true;
      if(!state.outbox.some(op=>op.entities.includes(detail.customerId)))state.customers[detail.customerId]=clone(detail);
    } else state.cache[path]=clone(data);
  }
  async function request<T>(ctx:OfflineCrmContext,method:string,path:string,body:unknown,network:CrmNetwork,requireCenterReceipt=false):Promise<Result<T>> {
    if(!ctx.active())return failure('UNAUTHORIZED','离线授权已失效，请登录');
    const state=load(ctx);
    const revision=contactRevisions.get(scopeKey(ctx))??0;
    if(method==='POST'&&editablePath(path)&&!requireCenterReceipt) {
      const key=scopeKey(ctx);
      const pending=(mutations.get(key)??Promise.resolve()).then(async()=>{
        if(!ctx.active())return failure('UNAUTHORIZED','账号已切换');
        const draft=load(ctx);
        const result=await queueCrmMutation(draft,ctx,path,body,uuid,now);
        if(!ctx.active())return failure('UNAUTHORIZED','账号已切换');
        if(result.ok){save(ctx,draft);void sync(ctx,network);}
        return result as Result<T>;
      });
      mutations.set(key,pending.catch(()=>undefined));
      return pending;
    }
    if(method==='GET') {
      const local=localRead(state,path);
      if(local.ok&&!(ctx.online()&&contactPath(path))){
        void sync(ctx,network);
        if(ctx.online()&&!path.startsWith('/api/crm/leads')&&path!=='/api/crm/bootstrap')void refreshCache(ctx,path,network);
        return local as Result<T>;
      }
      if(!ctx.online())return local as Result<T>;
    } else if(!ctx.online())return failure('UNAVAILABLE','此操作需要连接中心');
    const result=await network<T>(method,path,body);
    await settle(ctx);
    if(!ctx.active())return failure('UNAUTHORIZED','账号已切换');
    if(result.ok) {
      const latest=load(ctx);
      if(method!=='GET'&&(contactPath(path)||path==='/api/crm/imports')) {
        contactRevisions.set(scopeKey(ctx),(contactRevisions.get(scopeKey(ctx))??0)+1);
        for(const key of Object.keys(latest.cache))if(contactPath(key))delete latest.cache[key];
      } else if(contactPath(path)&&revision!==(contactRevisions.get(scopeKey(ctx))??0)) {
        return failure('CONFLICT','联系人已更新，请刷新');
      }
      absorb(latest,path,result.data);save(ctx,latest);void sync(ctx,network);
    } else if(contactPath(path)&&method==='GET'&&['FORBIDDEN','NOT_FOUND','UNAUTHORIZED'].includes(result.error.code)) {
      const latest=load(ctx);delete latest.cache[path];save(ctx,latest);
    } else if(unavailable(result)&&method==='GET')return localRead(load(ctx),path) as Result<T>;
    return result;
  }
  async function refreshCache(ctx:OfflineCrmContext,path:string,network:CrmNetwork) {
    const key=scopeKey(ctx)+path;if(refreshing.has(key))return;refreshing.add(key);
    try{const result=await network('GET',path);await settle(ctx);if(ctx.active()&&result.ok){const state=load(ctx);absorb(state,path,result.data);save(ctx,state);}}
    finally{refreshing.delete(key);}
  }
  function wire(state:OfflineCrmState,op:OfflineOperation):{path:string;body:Record<string,unknown>} {
    if(op.wire)return op.wire;
    const body=clone(op.body);
    if(typeof body.customerId==='string') {
      const id=state.aliases[body.customerId]??body.customerId;body.customerId=id;
      if(op.dependency&&state.versions[`${op.dependency}:${id}`]!==undefined)body.expectedVersion=state.versions[`${op.dependency}:${id}`];
      else if(op.dependency&&state.versions[op.dependency]!==undefined)body.expectedVersion=state.versions[op.dependency];
    }
    if(typeof body.contactId==='number')body.contactId=state.contacts[String(body.contactId)]??body.contactId;
    if(Array.isArray(body.contacts))body.contacts=body.contacts.map(c=>{
      const item={...c};if(item.contactId!==undefined)item.contactId=state.contacts[String(item.contactId)]??item.contactId;return item;
    });
    const id=typeof body.customerId==='string'?body.customerId:undefined;
    return {path:id?op.path.replace(/(\/leads\/)[^/]+/,'$1'+id):op.path,body};
  }
  function acknowledgeCustomer(state:OfflineCrmState,op:OfflineOperation,localId:string,detail:LeadDetail) {
    const canonical=state.aliases[localId]??localId;
    const old=state.customers[canonical];
    state.aliases[localId]=detail.customerId;
    state.aliases[canonical]=detail.customerId;
    state.versions[op.id]=detail.version;
    state.versions[`${op.id}:${detail.customerId}`]=detail.version;
    if(old) {
      for(const c of old.contacts) {
        const match=detail.contacts.filter(central=>c.email?central.email?.toLowerCase()===c.email.toLowerCase():central.name===c.name&&(central.phone??null)===(c.phone??null));
        if(match.length===1)state.contacts[String(c.contactId)]=match[0]!.contactId;
      }
    }
    const pending=state.outbox.filter(other=>other.id!==op.id&&other.entities.includes(canonical));
    const projection=pending.length&&old?clone(old):clone(detail);
    projection.customerId=detail.customerId;projection.version=detail.version+pending.length;
    projection.contacts=projection.contacts.map(c=>({...c,contactId:state.contacts[String(c.contactId)]??c.contactId}));
    projection.activities=projection.activities.map(a=>({...a,contactId:a.contactId?state.contacts[String(a.contactId)]??a.contactId:a.contactId}));
    delete state.customers[canonical];state.customers[detail.customerId]=projection;
    for(const view of Object.keys(state.views) as LeadQuery['view'][])state.views[view]=state.views[view]?.map(id=>id===canonical?detail.customerId:id);
    for(const later of pending)later.entities=later.entities.map(id=>id===canonical?detail.customerId:id);
  }
  async function drain(ctx:OfflineCrmContext,network:CrmNetwork):Promise<boolean> {
    const blocked=new Set<string>();
    for(const queued of load(ctx).outbox) {
      await settle(ctx);
      if(!ctx.active()||!ctx.online())return false;
      let state=load(ctx);const op=state.outbox.find(o=>o.id===queued.id);if(!op)continue;
      if(op.status!=='pending'||op.entities.some(id=>blocked.has(id))||op.dependency&&state.outbox.some(parent=>parent.id===op.dependency)){op.entities.forEach(id=>blocked.add(id));continue;}
      op.wire=wire(state,op);save(ctx,state); // Freeze before sending: restart and lost-response retry retain the exact request.
      const result=await network<LeadDetail|ImportReceipt>(op.method,op.wire.path,op.wire.body);
      await settle(ctx);
      if(!ctx.active())return false;
      state=load(ctx);const current=state.outbox.find(o=>o.id===op.id);if(!current)continue;
      if(!result.ok) {
        current.message=result.error.message;state.lastError=result.error.message;
        if(unavailable(result)){save(ctx,state);return false;}
        current.status=result.error.code==='CONFLICT'?'conflict':'failed';
        current.entities.forEach(id=>blocked.add(id));save(ctx,state);
        if(current.entities.length===1){const central=await network<LeadDetail>('GET',`/api/crm/leads/${current.entities[0]}`);await settle(ctx);if(!ctx.active())return false;if(central.ok){state=load(ctx);const latest=state.outbox.find(o=>o.id===current.id);if(latest)latest.central=central.data;save(ctx,state);}}
        continue;
      }
      if(op.path==='/api/crm/imports') {
        if(!validImport(result.data,(op.body.rows as unknown[]).length)){current.status='failed';current.replayOnly=true;current.message='中心导入回执不完整，保留本地数据等待核查';state.lastError=current.message;save(ctx,state);continue;}
        const local=op.response as ImportReceipt,receipt=result.data as ImportReceipt;
        for(const row of receipt.rows) {
          const localId=local.rows.find(r=>r.index===row.index)?.customerId;
          if(!localId)continue;
          if(row.customerId) {
            const detail=await network<LeadDetail>('GET',`/api/crm/leads/${row.customerId}`);
            await settle(ctx);
            if(!ctx.active())return false;
            if(!detail.ok||!validDetail(detail.data)){save(ctx,state);return false;}
            state=load(ctx);acknowledgeCustomer(state,current,localId,detail.data);
          }
        }
        if(receipt.rows.some(row=>!['created','duplicate'].includes(row.status))) {
          const pending=state.outbox.find(o=>o.id===op.id)!;pending.status='failed';pending.message='部分导入行被中心拒绝，请核对导入回执';pending.response=receipt;save(ctx,state);continue;
        }
      } else {
        if(!validDetail(result.data)||op.wire.body.customerId!==undefined&&result.data.customerId!==op.wire.body.customerId){current.status='failed';current.replayOnly=true;current.message='中心客户回执不完整，保留本地数据等待核查';state.lastError=current.message;save(ctx,state);continue;}
        acknowledgeCustomer(state,current,current.entities[0]!,result.data);
      }
      state.outbox=state.outbox.filter(o=>o.id!==op.id);save(ctx,state);
    }
    return true;
  }
  async function pull(ctx:OfflineCrmContext,network:CrmNetwork):Promise<boolean> {
    const bootstrap=await network<LeadBootstrap>('GET','/api/crm/bootstrap');
    await settle(ctx);
    if(!ctx.active())return false;
    if(!bootstrap.ok){const state=load(ctx);state.lastError=bootstrap.error.message;save(ctx,state);return false;}
    if(bootstrap.data?.userId!==ctx.userId||!Array.isArray(bootstrap.data.capabilities))return false;
    let state=load(ctx);absorb(state,'/api/crm/bootstrap',bootstrap.data);save(ctx,state);
    const knownCustomers=state.customers;
    const cap=bootstrap.data.capabilities;
    const views:LeadQuery['view'][]=cap.includes('leads.read.all')&&['shared','summary'].includes(bootstrap.data.scope)?['all']:cap.includes('leads.develop')?['personal','assigned']:[];
    if(cap.includes('leads.claim'))views.push('pool');
    if(['shared','summary'].includes(bootstrap.data.scope)&&['leads.import','leads.publish','leads.assign','followups.read'].some(c=>cap.includes(c))&&!views.includes('all'))views.push('operations');
    const memberships:Partial<Record<LeadQuery['view'],string[]>>={};
    const details:Record<string,LeadDetail>={};
    for(const view of views) {
      const ids:string[]=[];let offset=0;let total=0;
      do {
        const page=await network<LeadPage>('GET',`/api/crm/leads?view=${view}&search=&limit=${OFFLINE_CRM_LIMITS.pageSize}&offset=${offset}`);
        if(!ctx.active())return false;
        if(!page.ok)return false;
        total=page.data.total;
        if(!page.data.items.length&&offset<total)return false;
        for(const preview of page.data.items){
          ids.push(preview.customerId);
          const old=knownCustomers[preview.customerId];
          if(old?.version===preview.version&&old.customerKey){details[preview.customerId]=old;continue;}
          const detail=await network<LeadDetail>('GET',`/api/crm/leads/${preview.customerId}`);
          if(!ctx.active())return false;
          if(!detail.ok)return false;
          details[preview.customerId]=detail.data;
        }
        offset+=page.data.items.length;
      } while(offset<total);
      memberships[view]=[...new Set(ids)];
    }
    await settle(ctx);
    if(!ctx.active())return false;
    state=load(ctx);
    const dirty=new Set(state.outbox.flatMap(op=>op.entities));
    for(const [id,item] of Object.entries(state.customers))if(!dirty.has(id)&&!details[id])delete state.customers[id];
    for(const [id,item] of Object.entries(details))if(!dirty.has(id)){state.customers[id]=clone(item);state.cache[`detail:${id}`]=true;}
    state.views=memberships;
    state.views.mine=[...(memberships.personal??[]),...(memberships.assigned??[])];
    if(memberships.all){const all=Object.values(state.customers);state.views.personal=all.filter(c=>c.origin==='personal'&&c.ownerUserId===ctx.userId).map(c=>c.customerId);state.views.assigned=all.filter(c=>c.origin==='operations'&&c.ownerUserId===ctx.userId).map(c=>c.customerId);state.views.operations=all.filter(c=>c.origin==='operations').map(c=>c.customerId);}
    state.lastSyncedAt=now();state.lastError=undefined;save(ctx,state);return true;
  }
  async function sync(ctx:OfflineCrmContext,network:CrmNetwork,force=false):Promise<void> {
    try {await synchronize(ctx,network,force);}catch(error){report(error);}
  }
  async function synchronize(ctx:OfflineCrmContext,network:CrmNetwork,force=false):Promise<void> {
    if(!ctx.active()||!ctx.online())return;
    const key=scopeKey(ctx);if(running.has(key))return running.get(key)!;
    const previous=load(ctx);
    if(!force&&!previous.outbox.some(op=>op.status==='pending')&&previous.lastAttemptAt&&Date.parse(now())-Date.parse(previous.lastAttemptAt)<OFFLINE_CRM_LIMITS.sync_interval_seconds*MILLISECONDS_PER_SECOND)return;
    const pending=(async()=>{
      try {
        const state=load(ctx);state.lastAttemptAt=now();save(ctx,state);
        if(await drain(ctx,network)&&ctx.active()&&ctx.online())await pull(ctx,network);
      } catch(error) {
        report(error);
        if(ctx.active()){const state=load(ctx);state.lastError='客户同步失败，请查看日志';save(ctx,state);}
      }
    })();
    running.set(key,pending);try{await pending;}finally{if(running.get(key)===pending)running.delete(key);}
  }
  async function status(ctx:OfflineCrmContext):Promise<Result<CrmSyncStatus>> {
    if(!ctx.active())return failure('UNAUTHORIZED','离线授权已失效，请登录');
    const state=load(ctx);
    return success({connection:ctx.online()?'online':'offline',syncing:running.has(scopeKey(ctx)),pending:state.outbox.filter(op=>op.status==='pending').length,failed:state.outbox.filter(op=>op.status==='failed').length,conflicts:state.outbox.filter(op=>op.status==='conflict').length,lastSyncedAt:state.lastSyncedAt,lastError:state.lastError,issues:state.outbox.filter(op=>op.status!=='pending').map(op=>({id:op.id,customerId:op.entities[0],status:op.status as 'failed'|'conflict',message:op.message??'同步失败',local:state.customers[op.entities[0]!],central:op.central,receipt:op.path==='/api/crm/imports'?op.response as ImportReceipt:undefined,replayOnly:op.replayOnly}))});
  }
  async function resolve(ctx:OfflineCrmContext,input:CrmSyncResolve,network:CrmNetwork):Promise<Result<void>> {
    if(!ctx.active())return failure('UNAUTHORIZED','离线授权已失效，请登录');
    if(!ctx.online())return failure('UNAVAILABLE','处理同步问题需要联网');
    if(running.has(scopeKey(ctx)))return failure('CONFLICT','正在同步，请稍后再试');
    if(!input||!['retry','use-central'].includes(input.action))return failure('INVALID_INPUT','处理方式无效');
    let state=load(ctx);const op=state.outbox.find(o=>o.id===input.id&&o.status!=='pending');
    if(!op)return failure('NOT_FOUND','同步问题已处理');
    if(input.action==='use-central') {
      const central:LeadDetail[]=[];
      for(const id of op.entities){const result=await network<LeadDetail>('GET',`/api/crm/leads/${id}`);if(!ctx.active())return failure('UNAUTHORIZED','账号已切换');if(result.ok)central.push(result.data);else if(result.error.code!=='NOT_FOUND')return result;}
      state=load(ctx);const related=state.outbox.filter(o=>o.entities.some(id=>op.entities.includes(id)));const discarded=new Set(related.map(o=>o.id));
      state.outbox=state.outbox.filter(o=>!discarded.has(o.id));
      for(const id of op.entities)delete state.customers[id];
      for(const item of central)state.customers[item.customerId]=item;
      state.receipts={};save(ctx,state);
    } else if(op.replayOnly) {
      op.status='pending';op.message=undefined;save(ctx,state);
    } else {
      if(op.entities.length!==1||!op.body.customerId)return failure('INVALID_INPUT','导入问题请核对原文件，保留中心后重新导入');
      const result=await network<LeadDetail>('GET',`/api/crm/leads/${op.entities[0]}`);
      if(!ctx.active())return failure('UNAUTHORIZED','账号已切换');if(!result.ok)return result;
      if(!result.data.canEdit&&!result.data.canFollowup)return failure('FORBIDDEN','客户权限已变化');
      state=load(ctx);const latest=state.outbox.find(o=>o.id===op.id)!;
      latest.body.expectedVersion=result.data.version;latest.body.idempotencyKey=uuid();latest.dependency=undefined;latest.wire=undefined;latest.status='pending';latest.message=undefined;latest.central=result.data;
      save(ctx,state);
    }
    await sync(ctx,network,true);return success(undefined);
  }
  return {request,sync,status,resolve};
}
export type OfflineCrmService=ReturnType<typeof createOfflineCrmService>;
