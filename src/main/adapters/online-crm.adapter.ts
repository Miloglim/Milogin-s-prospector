import type { ImportFileContent } from "../../shared/online-crm";
import { dialog } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { parseImportTable, parseWorkbookImport } from './import-table.adapter';
import { failure, success } from '../../../server/core/crm';
import { DESKTOP_AUTH_ROUTES } from '../../../server/core/desktop-session';
import { API_ROUTES } from '../../../server/core/auth';
import type { DesktopLoginResponse } from '../../../server/core/desktop-session';
import { loginAccountId, type OnlineSessionStore, type SavedOnlineSession } from './online-session-store.adapter';
import type { LoginAccountQuery, SavedAccountLogin, OnlineLogout } from '../../shared/online-crm';
import { isCenterUnavailable, OFFLINE_ACCESS_LIMITS } from '../../../server/core/offline-access';
import type { OfflineAccessGrant } from '../../../server/core/offline-access';
import { verifyOfflineAccess } from './offline-access-verifier.adapter';
import type { AccountProfile, Result, Identity, OnlineLogin, OnlinePasswordChange, OnlineSessionSnapshot, ImportPreview, OnlineFeed, OnlineFeedRequest, OnlineRegistration, RegisteredAccount } from '../../shared/online-crm';
import { ONLINE_LIMITS } from '../../shared/online-crm';
import type { OnlineCrmPort } from '../services/online-crm.service';
import { Log } from '../logger';
import { TASK_ROUTES, type FollowupTask, type TaskQuery, type TaskPage, type TaskCreate, type TaskReschedule, type TaskComplete } from '../../../server/core/tasks';
import type { OfflineCrmService } from '../services/offline-crm.service';
import type { OfflineCrmContext } from '../core/offline-crm';
import type { CrmSyncResolve, CrmSyncStatus } from '../../shared/online-crm';
import { CONTACT_COMMAND_PREFIX } from '../core/contact-commands';
import { validateCenterBase } from '../core/center-endpoint';

const FALLBACK_ACCESS_MS = 3600000;
const RENEW_BEFORE_MS = 30000;
const MILLISECONDS_PER_SECOND = 1000;
const CLOCK_FLOOR_PERSIST_MS = 30000;
const ACCOUNT_ID_MAX_LENGTH = 2048;
/** One identity authority for both the global shell and existing CRM commands. */
export class OnlineCrmAdapter implements OnlineCrmPort {
  private contactWriter: Pick<ReturnType<typeof import('../services/contact-command.service').createContactCommandService>, 'update' | 'followup'> | undefined;
  private contactSync?: {
    status(): Pick<CrmSyncStatus, 'pending' | 'failed' | 'conflicts' | 'issues'> & { syncing?: boolean };
    sync(): Promise<Result<void>>;
    resolve(input: CrmSyncResolve): Promise<Result<void>>;
  };
  setContactSync(sync: typeof this.contactSync): void { this.contactSync = sync; }
  setContactWriter(writer: typeof this.contactWriter): void { this.contactWriter = writer; }
  contactUpdate(input: import('../../../server/core/contact-assignments').CenterContactUpdate) { return this.contactWriter?.update(input) ?? Promise.resolve(failure('UNAVAILABLE', '联系人保存尚未就绪')); }
  contactFollowup(input: import('../../../server/core/contact-assignments').CenterContactFollowup) { return this.contactWriter?.followup(input) ?? Promise.resolve(failure('UNAVAILABLE', '跟进保存尚未就绪')); }
  private detailReader: ((reference: import('../../../server/core/contact-assignments').CenterContactRef) => Promise<Result<import('../../../server/core/contact-assignments').CenterContactDetail>>) | undefined;
  setDetailReader(reader: typeof this.detailReader): void { this.detailReader = reader; }
  contactDetail(reference: import('../../../server/core/contact-assignments').CenterContactRef): Promise<Result<import('../../../server/core/contact-assignments').CenterContactDetail>> {
    return this.detailReader?.(reference) ?? Promise.resolve(failure('UNAVAILABLE', '联系人详情读取尚未就绪'));
  }
  private contactReader: ((query: import('../../../server/core/center-contacts').CenterContactQuery) => Promise<Result<import('../../../server/core/center-contacts').CenterContactPage>>) | undefined;
  setContactReader(reader: typeof this.contactReader): void { this.contactReader = reader; }
  contacts(query: import('../../../server/core/center-contacts').CenterContactQuery): Promise<Result<import('../../../server/core/center-contacts').CenterContactPage>> {
    return this.contactReader?.(query) ?? Promise.resolve(failure('UNAVAILABLE', '联系人本地读取尚未就绪'));
  }
  contactReadContext():OfflineCrmContext|null { return this.crmContext(); }
  /** Legacy SQLite migration is limited to ordinary sales identities. */
  legacyPersonalImportAllowed(): boolean { return !!this.identity && !this.identity.identityAdmin && this.identity.crmRoles.includes('sales'); }
  private readonly responseObservers=new Set<(context:{baseUrl:string;userId:string},method:string,path:string,data:unknown)=>void>();
  onResponse(observer:(context:{baseUrl:string;userId:string},method:string,path:string,data:unknown)=>void):()=>void {this.responseObservers.add(observer);return()=>{this.responseObservers.delete(observer);};}
  /** A complete mirror scan must never substitute an old cached page for a center response. */
  requestLive<T>(method:string,path:string,body?:unknown):Promise<Result<T>> {return this.onlineRequest<T>(method,path,body);}
  private baseUrl:string;
  private token='';
  private generation=0;
  private credentialRevision=0;
  private deviceId=randomUUID();
  private cursor='0';
  private feedRevision=0;
  private identity:Identity|null=null;
  private refreshToken='';
  private remembered=false;
  private autoLogin=false;
  private switchingAccount=false;
  private expiresAt=0;
  private renewal:Promise<Result<void>>|null=null;
  private restoration:Promise<Result<OnlineSessionSnapshot>>|null=null;
  private disk:Promise<void>=Promise.resolve();
  private connection:'online'|'offline'='online';
  private offlineAccess?:OfflineAccessGrant;
  private trustedPublicKey='';
  private lastSeenAt=0;
  private localExpiresAt=0;
  private localExpired=false;
  private persistedClockFloor=0;
  private lastIdentityState='';
  constructor(private readonly fetcher:typeof fetch=fetch, private readonly store?:OnlineSessionStore, private readonly changed:()=>void=()=>{}, private readonly localCrm?:OfflineCrmService, initialBaseUrl:string=ONLINE_LIMITS.defaultUrl) {
    this.baseUrl=validateCenterBase(initialBaseUrl) ?? ONLINE_LIMITS.defaultUrl;
  }
  private crmContext():OfflineCrmContext|null {
    const current=this.currentIdentity();if(!current||!this.identity)return null;
    const generation=this.generation;
    const permissionKey=JSON.stringify([this.identity.crmRoles.slice().sort(),this.identity.crmCapabilities?.slice().sort(),this.identity.identityAdmin]);
    return {...current,permissionKey,active:()=>generation===this.generation&&this.currentIdentity()?.userId===current.userId&&permissionKey===JSON.stringify([this.identity!.crmRoles.slice().sort(),this.identity!.crmCapabilities?.slice().sort(),this.identity!.identityAdmin]),online:()=>this.connection==='online'};
  }
  async syncStatus(): Promise<Result<CrmSyncStatus>> {
    const ctx=this.crmContext();if(!ctx||!this.localCrm)return failure('UNAUTHORIZED','请登录客户中心');
    const existing=await this.localCrm.status(ctx);if(!existing.ok||!ctx.active())return existing.ok?failure('UNAUTHORIZED','账号已切换'):existing;
    const contacts=this.contactSync?.status();if(!contacts)return existing;
    return success({...existing.data,syncing:existing.data.syncing||!!contacts.syncing,pending:existing.data.pending+contacts.pending,failed:existing.data.failed+contacts.failed,conflicts:existing.data.conflicts+contacts.conflicts,issues:[...existing.data.issues,...contacts.issues]});
  }
  async syncNow(){
    const ctx=this.crmContext();if(!ctx||!this.localCrm)return failure('UNAUTHORIZED','请登录客户中心');
    await this.localCrm.sync(ctx,(m,p,b)=>this.onlineRequest(m,p,b),true);
    if(!ctx.active())return failure('UNAUTHORIZED','账号已切换');
    const contactResult=await this.contactSync?.sync();if(contactResult&&!contactResult.ok)return contactResult;
    return this.syncStatus();
  }
  async syncResolve(input:CrmSyncResolve){
    const ctx=this.crmContext();if(!ctx||!this.localCrm)return failure('UNAUTHORIZED','请登录客户中心');
    if(!input||typeof input.id!=='string'||!['retry','use-central'].includes(input.action))return failure('INVALID_INPUT','同步处理参数无效');
    if(input.id.startsWith(CONTACT_COMMAND_PREFIX)){
      if(!this.contactSync)return failure('UNAVAILABLE','联系人同步尚未就绪');
      const result=await this.contactSync.resolve(input);if(!result.ok)return result;
      if(!ctx.active())return failure('UNAUTHORIZED','账号已切换');
      return this.contactSync.sync();
    }
    return this.localCrm.resolve(ctx,input,(m,p,b)=>this.onlineRequest(m,p,b));
  }
  currentIdentity():{userId:string;baseUrl:string}|null {
    if(this.switchingAccount){this.reportIdentityState('switching-account');return null;}
    if(this.connection==='offline') {
      const now=Date.now();
      const wasExpired=this.localExpired;
      if(now+OFFLINE_ACCESS_LIMITS.clock_skew_seconds*MILLISECONDS_PER_SECOND<this.lastSeenAt || Math.max(now,this.lastSeenAt)>=this.localExpiresAt)this.localExpired=true;
      this.lastSeenAt=Math.max(now,this.lastSeenAt);
      if(this.lastSeenAt-this.persistedClockFloor>=CLOCK_FLOOR_PERSIST_MS || this.localExpired&&!wasExpired){
        if(this.remembered&&this.store&&this.offlineAccess&&this.identity&&!this.renewal){
          this.persistedClockFloor=this.lastSeenAt;
          const generation=this.generation,revision=this.credentialRevision,saved=this.savedSession(this.identity.userId);
          // A queued clockfloor must not restore a credential consumed by concurrent renewal.
          void this.diskAction(async()=>{if(generation===this.generation&&revision===this.credentialRevision)await this.store!.save(saved);}).catch(()=>{Log.error('online.storage','离线时钟保护无法保存，本次拒绝离线访问');if(generation===this.generation&&revision===this.credentialRevision)this.localExpired=true;});
        }
      }
      if(this.localExpired){this.reportIdentityState('offline-expired');return null;}
    }
    const current=this.identity&&!this.identity.mustChangePassword?{userId:this.identity.userId,baseUrl:this.baseUrl}:null;
    this.reportIdentityState(current?`ready:${this.connection}:${current.userId}`:!this.identity?'anonymous':this.identity.mustChangePassword?'password-change-required':'unavailable');
    return current;
  }
  private reportIdentityState(state:string):void { if(state!==this.lastIdentityState){this.lastIdentityState=state;Log.info?.('online.identity',`身份状态 ${state}`);} }
  isOnline():boolean { return this.connection==='online' && !!this.currentIdentity(); }
  private snapshot():OnlineSessionSnapshot { return {identity:this.connection==='offline'&&!this.currentIdentity()?null:this.identity,remembered:this.remembered,baseUrl:this.baseUrl,connection:this.connection,...(this.connection==='offline'&&this.localExpiresAt?{offlineExpiresAt:new Date(this.localExpiresAt).toISOString()}: {})}; }
  private savedSession(userId:string,refreshToken=this.refreshToken,email=this.identity?.email):SavedOnlineSession { return {baseUrl:this.baseUrl,userId,refreshToken,email,autoLogin:this.autoLogin,...(this.offlineAccess?{offlineAccess:this.offlineAccess,trustedPublicKey:this.trustedPublicKey,lastSeenAt:this.lastSeenAt}:{})}; }
  private async offline():Promise<boolean> {
    if(!this.identity || this.identity.mustChangePassword)return false;
    this.connection='offline';
    if(!this.currentIdentity()){this.changed();return false;}
    const generation=this.generation,userId=this.identity.userId;this.persistedClockFloor=this.lastSeenAt;
    if(this.remembered && this.store && this.offlineAccess)try{await this.diskAction(async()=>{if(generation===this.generation)await this.store!.save(this.savedSession(userId));});}catch{Log.error('online.storage','离线时钟保护无法保存，本次拒绝离线访问');if(generation===this.generation)this.localExpired=true;return false;}
    if(generation!==this.generation)return false;
    this.changed();return true;
  }
  private async diskAction(action:()=>Promise<void>):Promise<void> {
    const next=this.disk.then(action); this.disk=next.catch(()=>{Log.error('online.storage','登录信息存储失败');}); await next;
  }
  private invalidate(notify=true) {
    this.generation++; this.token=''; this.refreshToken='';this.identity=null;this.remembered=false;this.autoLogin=false;this.expiresAt=0;
    this.renewal=null;this.cursor='0';this.feedRevision++;this.deviceId=randomUUID();
    this.connection='online';this.offlineAccess=undefined;this.trustedPublicKey='';this.lastSeenAt=0;this.persistedClockFloor=0;this.localExpiresAt=0;this.localExpired=false;
    if(notify)this.changed();
  }
  private async forget():Promise<void> {
    this.invalidate(false);
    if(this.store)try { await this.diskAction(()=>this.store!.clear()); } catch { Log.error('online.storage','清理登录信息失败，后续恢复将由服务器再次校验'); }
    this.changed();
  }
  private async raw<T>(method:string,path:string,body?:unknown,bearer?:string):Promise<Result<T>> {
    try {
      const response=await this.fetcher(`${this.baseUrl}${path}`,{method,redirect:'error',headers:{...(bearer?{Authorization:`Bearer ${bearer}`} : {}),'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(ONLINE_LIMITS.timeoutMs)});
      const result=JSON.parse(await this.boundedText(response)) as Result<T>;
      if(typeof result?.ok!=='boolean' || (!result.ok && (typeof result.error?.code!=='string'||typeof result.error.message!=='string')))return failure('UNAVAILABLE','中心返回格式错误');
      return result;
    } catch(error) {
      const detail=error instanceof Error?`${error.name}: ${error.message}`:'unknown';
      Log.error('online.request',`中心请求失败 ${method} ${path} origin=${this.baseUrl} (${detail})`);
      return failure('UNAVAILABLE','中心不可达，请检查连接');
    }
  }
  private async accept(data:DesktopLoginResponse,generation:number):Promise<Result<void>> {
    if(generation!==this.generation)return failure('UNAUTHORIZED','账号已切换，旧响应已丢弃');
    if(typeof data?.token!=='string'||!data.identity?.userId || !data.identity.email || !Array.isArray(data.identity.crmRoles))return failure('UNAVAILABLE','登录响应格式错误');
    const refresh=typeof data.refreshToken==='string'?data.refreshToken:'';
    if(this.store&&!refresh)return failure('UNAVAILABLE','中心缺少续期契约，请更新中心服务');
    if(this.remembered && (!refresh || !this.store))return failure('UNAVAILABLE','无法安全保存登录状态');
    this.credentialRevision++;
    const now=Date.now();
    const offline=!data.identity.mustChangePassword&&data.offlineAccess?verifyOfflineAccess(data.offlineAccess,{trustedPublicKey:data.offlineAccess.publicKey,baseUrl:this.baseUrl,userId:data.identity.userId,lastSeenAt:now,now}):null;
    this.offlineAccess=offline?data.offlineAccess:undefined;this.trustedPublicKey=offline?data.offlineAccess!.publicKey:'';this.lastSeenAt=now;this.persistedClockFloor=now;
    this.localExpiresAt=offline?Date.parse(offline.expiresAt):now+OFFLINE_ACCESS_LIMITS.validity_seconds*MILLISECONDS_PER_SECOND;this.localExpired=false;
    if(this.remembered) {
      await this.diskAction(async()=>{if(generation===this.generation)await this.store!.save(this.savedSession(data.identity.userId,refresh,data.identity.email));});
      if(generation!==this.generation)return failure('UNAUTHORIZED','登录已取消');
    } else if(this.store?.record) {
      await this.diskAction(async()=>{if(generation===this.generation)await this.store!.record!({baseUrl:this.baseUrl,userId:data.identity.userId,email:data.identity.email});});
      if(generation!==this.generation)return failure('UNAUTHORIZED','登录已取消');
    }
    this.token=data.token;this.refreshToken=refresh;this.identity=data.identity;this.connection='online';
    this.expiresAt=Date.parse(data.expiresAt)||Date.now()+FALLBACK_ACCESS_MS;if(!this.switchingAccount)this.changed();return success(undefined);
  }
  private async renew(expectedUserId?:string):Promise<Result<void>> {
    if(this.renewal)return this.renewal;
    if(this.switchingAccount)return failure('UNAUTHORIZED','正在切换账号');
    if(!this.refreshToken)return failure('UNAUTHORIZED','请重新登录中心账号');
    const generation=this.generation;const refresh=this.refreshToken;
    const pending=(async()=>{
      const result=await this.raw<DesktopLoginResponse>('POST',DESKTOP_AUTH_ROUTES.refresh,{refreshToken:refresh});
      if(generation!==this.generation)return failure('UNAUTHORIZED','账号已切换');
      if(!result.ok){Log.warn?.('online.renew',`登录续期失败 ${result.error.code}: ${result.error.message}`);if(result.error.code==='UNAUTHORIZED')await this.forget();else if(isCenterUnavailable(result.error.code))await this.offline();return result;}
      if((this.identity||expectedUserId) && result.data.identity?.userId!==(this.identity?.userId??expectedUserId)){await this.forget();return failure('UNAUTHORIZED','恢复身份不一致');}
      try{return await this.accept(result.data,generation);}catch{
        if(generation!==this.generation)return failure('UNAUTHORIZED','账号已切换，旧存储失败已丢弃');
        await this.raw('POST',DESKTOP_AUTH_ROUTES.logout,{refreshToken:result.data.refreshToken});
        if(generation===this.generation)await this.forget();return failure('UNAVAILABLE','无法安全保存续期状态，请重新登录');
      }
    })();
    this.renewal=pending;try{return await pending;}finally{if(this.renewal===pending)this.renewal=null;}
  }
  async request<T>(method:string,path:string,body?:unknown,requireCenterReceipt=false):Promise<Result<T>> {
    const context=this.crmContext();
    const result=await this.requestWithCache<T>(method,path,body,requireCenterReceipt);
    const current=this.currentIdentity();
    if(result.ok&&context?.active()&&current?.userId===context.userId&&current.baseUrl===context.baseUrl) {
      for(const observer of this.responseObservers)try{observer(context,method,path,result.data);}catch(error){Log.error('contact.mirror','联系人投影更新失败',error instanceof Error?error.stack:undefined);}
    }
    return result;
  }
  private async requestWithCache<T>(method:string,path:string,body?:unknown,requireCenterReceipt=false):Promise<Result<T>> {
    if(this.localCrm&&path.startsWith('/api/crm/')&&!path.startsWith('/api/crm/notifications')){
      const ctx=this.crmContext();if(!ctx)return failure('UNAUTHORIZED','请登录客户中心');
      try{return await this.localCrm.request<T>(ctx,method,path,body,(m,p,b)=>this.onlineRequest(m,p,b),requireCenterReceipt);}
      catch(error){Log.error('offline.crm',`本地客户库读写失败 (${error instanceof Error?error.name:'unknown'})`);return failure('DATABASE_ERROR','本地客户库暂不可用，请检查磁盘或日志');}
    }
    if(this.connection==='offline')return failure('UNAVAILABLE','中心暂时不可用，请恢复连接后重试');
    return this.onlineRequest(method,path,body);
  }
  private async onlineRequest<T>(method:string,path:string,body?:unknown):Promise<Result<T>> {
    if(this.switchingAccount)return failure('UNAUTHORIZED','正在切换账号');
    const generation=this.generation;
    if(!this.token) return failure('UNAUTHORIZED','请登录中心账号');
    if(this.refreshToken && Date.now()>=this.expiresAt-RENEW_BEFORE_MS){const fresh=await this.renew();if(!fresh.ok)return fresh;}
    if(generation!==this.generation)return failure('UNAUTHORIZED','账号已切换');
    let result=await this.raw<T>(method,path,body,this.token);
    if(generation!==this.generation)return failure('UNAUTHORIZED','账号已切换，旧响应已丢弃');
    if(!result.ok && result.error.code==='UNAUTHORIZED' && this.refreshToken){const fresh=await this.renew();if(!fresh.ok)return fresh;if(generation!==this.generation)return failure('UNAUTHORIZED','账号已切换');result=await this.raw<T>(method,path,body,this.token);}
    if(generation!==this.generation)return failure('UNAUTHORIZED','账号已切换，旧响应已丢弃');
    if(!result.ok && result.error.code==='UNAUTHORIZED'){Log.warn?.('online.request',`${method} ${path} 鉴权失败，清理当前登录状态`);await this.forget();}
    else if(!result.ok && isCenterUnavailable(result.error.code)){Log.warn?.('online.request',`${method} ${path} 中心不可用，切换离线状态`);await this.offline();}
    return result;
  }
  private async boundedText(response:Response):Promise<string> {
    if(!response.body) throw new Error('Empty response');
    const reader=response.body.getReader(); let bytes=0; const chunks:Uint8Array[]=[];
    try {
      while(true) { const part=await reader.read(); if(part.done) break; bytes+=part.value.length; if(bytes>ONLINE_LIMITS.responseBytes) throw new Error('Response limit'); chunks.push(part.value); }
    } finally { await reader.cancel(); }
    return Buffer.concat(chunks).toString('utf8');
  }
  register(input:OnlineRegistration):Promise<Result<RegisteredAccount>> {
    return this.raw<RegisteredAccount>('POST',DESKTOP_AUTH_ROUTES.register,input);
  }
  async login(input:OnlineLogin):Promise<Result<Identity>> {
    if(!input || typeof input.baseUrl!=='string' || typeof input.email!=='string' || typeof input.password!=='string') return failure('INVALID_INPUT','登录参数错误');
    if(input.autoLogin!==undefined&&typeof input.autoLogin!=='boolean'||input.remember!==undefined&&typeof input.remember!=='boolean'||input.autoLogin===true&&input.remember!==true)return failure('INVALID_INPUT','自动登录需要记住登录凭据');
    const base=validateCenterBase(input.baseUrl);
    if(!base) return failure('INVALID_INPUT','中心地址必须使用 HTTPS；本机测试仅允许回环 HTTP');
    this.invalidate(false);
    const generation=this.generation;
    this.baseUrl=base;
    this.remembered=input.remember===true;
    this.autoLogin=this.remembered&&(input.autoLogin??true);
    try {
      if(generation!==this.generation)return failure('UNAUTHORIZED','登录已取消');
      this.changed();
      const result=await this.raw<DesktopLoginResponse>('POST',DESKTOP_AUTH_ROUTES.login,{email:input.email,password:input.password});
      if(generation!==this.generation) return failure('UNAUTHORIZED','登录已取消');
      if(!result.ok) return result;
      const accepted=await this.accept(result.data,generation);if(!accepted.ok)return accepted;
      const me=await this.request<Identity>('GET',DESKTOP_AUTH_ROUTES.me);
      if(me.ok && generation===this.generation){this.identity=me.data;this.changed();}
      return me;
    } catch(error) { Log.error('online.login',`登录状态保存失败 (${error instanceof Error?error.name:'unknown'})`);if(generation===this.generation)await this.forget();return failure('UNAVAILABLE','登录状态无法安全保存，请重试'); }
  }
  accountProfile():Promise<Result<AccountProfile>> { return this.request<AccountProfile>('GET',API_ROUTES.accountProfile); }
  async logout(input?:OnlineLogout):Promise<Result<void>> {
    if(input!==undefined&&(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>key!=='switchAccount')||input.switchAccount!==undefined&&typeof input.switchAccount!=='boolean'))return failure('INVALID_INPUT','退出参数无效');
    if(input?.switchAccount&&this.remembered){
      if(!this.store?.deselect)return failure('UNAVAILABLE','账号切换暂不可用');
      if(this.switchingAccount)return failure('INVALID_INPUT','正在切换账号');
      this.switchingAccount=true;
      // Finish token rotation before saving the selection; otherwise the retained token may already be consumed.
      try{await this.renewal;await this.diskAction(()=>this.store!.deselect!());}
      catch{Log.error('online.storage','切换账号时保存登录选择失败');return failure('UNAVAILABLE','无法安全切换账号，请重试');}
      finally{this.switchingAccount=false;}
      this.invalidate();return success(undefined);
    }
    const pending=this.refreshToken?this.raw<void>('POST',DESKTOP_AUTH_ROUTES.logout,{refreshToken:this.refreshToken}):this.token?this.raw<void>('POST',API_ROUTES.logout,{},this.token):Promise.resolve(success(undefined));
    this.invalidate(false);const generation=this.generation;
    if(this.store)try{await this.diskAction(()=>this.store!.clear());}catch{Log.error('online.storage','退出时清理加密凭据失败');}
    const result=await pending;
    // A bound local runtime may synchronously exit in its observer; finish revocation first.
    if(generation===this.generation)this.changed();
    // Local logout is immediate even offline; do not claim server revocation succeeded.
    return result;
  }
  async status():Promise<Result<OnlineSessionSnapshot>> {
    if(!this.identity)return this.remembered&&this.refreshToken?this.restore():success(this.snapshot());
    const generation=this.generation;
    if(this.connection==='offline'&&this.refreshToken){
      const fresh=await this.renew();if(!fresh.ok)return isCenterUnavailable(fresh.error.code)&&this.currentIdentity()?success(this.snapshot()):fresh;
    }
    const me=await this.onlineRequest<Identity>('GET',DESKTOP_AUTH_ROUTES.me);
    if(!me.ok)return isCenterUnavailable(me.error.code)&&this.currentIdentity()?success(this.snapshot()):me;
    if(generation!==this.generation)return failure('UNAUTHORIZED','账号已切换');
    if(me.data.userId!==this.identity?.userId){await this.forget();return failure('UNAUTHORIZED','中心身份不一致');}
    this.identity=me.data;this.connection='online';
    if(!this.offlineAccess){this.lastSeenAt=Date.now();this.localExpiresAt=this.lastSeenAt+OFFLINE_ACCESS_LIMITS.validity_seconds*MILLISECONDS_PER_SECOND;this.localExpired=false;}
    this.changed();
    const ctx=this.crmContext();if(ctx&&this.localCrm)void this.localCrm.sync(ctx,(m,p,b)=>this.onlineRequest(m,p,b));
    return success(this.snapshot());
  }
  async accounts():Promise<Result<LoginAccountQuery>> {
    try{return success(await this.store?.list?.()??{accounts:[]});}
    catch{Log.error('online.storage','无法读取账号预设');return failure('UNAVAILABLE','账号预设暂不可用');}
  }
  async removeAccount(accountId:string):Promise<Result<void>> {
    if(typeof accountId!=='string'||!accountId||accountId.length>ACCOUNT_ID_MAX_LENGTH)return failure('INVALID_INPUT','账号选择无效');
    if(!this.store?.remove)return failure('UNAVAILABLE','账号预设暂不可用');
    try{await this.diskAction(async()=>{
      if(this.identity&&loginAccountId({baseUrl:this.baseUrl,userId:this.identity.userId})===accountId)throw new Error('Active account');
      await this.store!.remove!(accountId);
    });return success(undefined);}catch{Log.warn('online.storage','账号预设移除失败');return failure('INVALID_INPUT','请先退出该账号后再移除');}
  }
  async loginAccount(input:SavedAccountLogin):Promise<Result<OnlineSessionSnapshot>> {
    if(!input||typeof input.accountId!=='string'||!input.accountId||input.accountId.length>ACCOUNT_ID_MAX_LENGTH||typeof input.autoLogin!=='boolean')return failure('INVALID_INPUT','账号选择无效');
    if(this.identity)return failure('INVALID_INPUT','请先退出当前账号');
    this.invalidate(false);this.restoration=null;
    return this.restoreSelected(input.accountId,input.autoLogin);
  }
  restore():Promise<Result<OnlineSessionSnapshot>> {return this.restoreSelected();}
  private async restoreSelected(accountId?:string,autoLogin?:boolean):Promise<Result<OnlineSessionSnapshot>> {
    if(this.restoration)return this.restoration;
    const generation=this.generation;
    const pending=(async()=>{
      if(this.identity)return this.status();
      const saved=await this.store?.load(accountId);
      if(generation!==this.generation)return failure('UNAUTHORIZED','登录恢复已取消');
      if(!saved)return accountId?failure('UNAUTHORIZED','请重新输入密码登录'):success(this.snapshot());
      if(accountId===undefined&&saved.baseUrl!==this.baseUrl)return success(this.snapshot());
      const base=validateCenterBase(saved.baseUrl);if(!base){await this.forget();return failure('INVALID_INPUT','已保存的中心地址不受支持');}
      this.baseUrl=base;this.refreshToken=saved.refreshToken;this.remembered=true;this.autoLogin=autoLogin??saved.autoLogin!==false;
      const offline=verifyOfflineAccess(saved.offlineAccess,{trustedPublicKey:saved.trustedPublicKey??'',baseUrl:base,userId:saved.userId,lastSeenAt:saved.lastSeenAt??NaN,now:Date.now()});
      const result=await this.renew(saved.userId);
      if(!result.ok){
        if(generation===this.generation && isCenterUnavailable(result.error.code)&&offline){
          this.identity=offline.identity;this.offlineAccess=saved.offlineAccess;this.trustedPublicKey=saved.trustedPublicKey!;this.lastSeenAt=saved.lastSeenAt!;this.persistedClockFloor=this.lastSeenAt;this.localExpiresAt=Date.parse(offline.expiresAt);
          if(await this.offline())return success(this.snapshot());
        }
        return result;
      }
      if(this.snapshot().identity?.userId!==saved.userId){await this.forget();return failure('UNAUTHORIZED','已保存的身份不一致');}
      return success(this.snapshot());
    })();this.restoration=pending;
    try{return await pending;}finally{if(this.restoration===pending)this.restoration=null;}
  }
  async changePassword(input:OnlinePasswordChange):Promise<Result<void>> {
    const result=await this.request<void>('POST',DESKTOP_AUTH_ROUTES.password,input);
    if(result.ok)await this.forget();return result;
  }
  /** App exit preserves remembered credentials; explicit logout alone revokes them. */
  dispose():void { this.generation++;this.token='';this.identity=null; }
  async feed(input?:OnlineFeedRequest):Promise<Result<OnlineFeed>> {
    if(input!==undefined && (!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(key=>key!=='reset') || input.reset!==undefined && typeof input.reset!=='boolean'))return failure('INVALID_INPUT','通知参数错误');
    if(input?.reset){this.cursor='0';this.feedRevision++;}
    const revision=this.feedRevision;
    const generation=this.generation;
    const result=await this.request<OnlineFeed>('GET',`/api/crm/notifications?deviceId=${this.deviceId}&after=${this.cursor}&limit=${ONLINE_LIMITS.feedPage}`);
    if(revision!==this.feedRevision)return failure('UNAVAILABLE','通知范围已变化，请重试');
    if(result.ok && generation===this.generation) this.cursor=result.data.nextCursor;
    return result;
  }
  async preview(input?:ImportFileContent):Promise<Result<ImportPreview>> {
    if(input===undefined)return this.readPreview(false);
    if(!this.currentIdentity())return failure('UNAUTHORIZED','请登录中心账号');
    if(!input||typeof input!=='object'||!['csv','xlsx','tsv'].includes(input.type)||typeof input.data!=='string'||(input.encoding!==undefined&&input.encoding!=='base64'))return failure('INVALID_INPUT','文件内容无效');
    if(input.data.length>ONLINE_LIMITS.fileBytes*2)return failure('PAYLOAD_TOO_LARGE','文件超过10 MiB');
    try {
      const encoded=input.type==='xlsx'||input.encoding==='base64';
      if(encoded&&!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data))return failure('INVALID_INPUT','文件内容编码无效');
      const bytes=Buffer.from(input.data,encoded?'base64':'utf8');
      if(bytes.length>ONLINE_LIMITS.fileBytes)return failure('PAYLOAD_TOO_LARGE','文件超过10 MiB');
      return parseImportTable(bytes,`导入.${input.type}`);
    } catch {return failure('INVALID_INPUT','文件解析失败');} // Untrusted file content never writes local CRM.
  }
  tasks(query:TaskQuery):Promise<Result<TaskPage>> {
    if (!query || typeof query!=='object' || Array.isArray(query)) return Promise.resolve(failure('INVALID_INPUT','任务查询无效'));
    return this.request('GET',`${TASK_ROUTES.tasks}?${new URLSearchParams({limit:String(query.limit),offset:String(query.offset),...(query.customerId?{customerId:query.customerId}:{}),...(query.status?{status:query.status}:{})})}`);
  }
  createTask(input:TaskCreate):Promise<Result<FollowupTask>> { return this.request('POST',TASK_ROUTES.tasks,input); }
  rescheduleTask(input:TaskReschedule):Promise<Result<FollowupTask>> { return input && typeof input.taskId==='string' ? this.request('POST',`${TASK_ROUTES.tasks}/${encodeURIComponent(input.taskId)}/${TASK_ROUTES.rescheduleAction}`,input) : Promise.resolve(failure('INVALID_INPUT','任务参数无效')); }
  completeTask(input:TaskComplete):Promise<Result<FollowupTask>> { return input && typeof input.taskId==='string' ? this.request('POST',`${TASK_ROUTES.tasks}/${encodeURIComponent(input.taskId)}/${TASK_ROUTES.completeAction}`,input) : Promise.resolve(failure('INVALID_INPUT','任务参数无效')); }
  workbookPreview():Promise<Result<ImportPreview>> { return this.readPreview(true); }
  private async readPreview(workbook:boolean):Promise<Result<ImportPreview>> {
    if(!this.currentIdentity()) return failure('UNAUTHORIZED','请登录中心账号');
    const generation=this.generation;
    const selected=await dialog.showOpenDialog({properties:['openFile'],filters:[{name:'线索表格',extensions:['csv','xlsx','xls']}]});
    if(generation!==this.generation) return failure('UNAUTHORIZED','账号已切换');
    if(selected.canceled || !selected.filePaths[0]) return failure('INVALID_INPUT','未选择文件');
    const file=selected.filePaths[0];
    try {
      if((await stat(file)).size>ONLINE_LIMITS.fileBytes) return failure('PAYLOAD_TOO_LARGE','文件超过 10 MiB');
      const bytes=await readFile(file);
      if(generation!==this.generation) return failure('UNAUTHORIZED','账号已切换');
      if(bytes.byteLength>ONLINE_LIMITS.fileBytes) return failure('PAYLOAD_TOO_LARGE','文件超过 10 MiB');
      return (workbook ? parseWorkbookImport : parseImportTable)(bytes,file.split(/[\\/]/).pop()??'线索表格');
    } catch(error) { Log.error('online.preview',`表格读取失败 (${error instanceof Error?error.name:'unknown'})`); return failure('INVALID_INPUT','无法读取表格'); }
  }
}

