import { app, safeStorage } from 'electron';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { Log } from '../logger';
import type { OfflineAccessGrant } from '../../../server/core/offline-access';
import type { LoginAccountQuery } from '../../shared/online-crm';
export interface SavedOnlineSession { baseUrl: string; userId: string; refreshToken: string; email?: string; autoLogin?: boolean; lastUsedAt?: number; offlineAccess?: OfflineAccessGrant; trustedPublicKey?: string; lastSeenAt?: number; }
export interface OnlineSessionStore {
  load(accountId?: string): Promise<SavedOnlineSession | null>;
  save(value: SavedOnlineSession): Promise<void>;
  clear(): Promise<void>;
  deselect?(): Promise<void>;
  list?(): Promise<LoginAccountQuery>;
  remove?(accountId: string): Promise<void>;
  record?(value: {baseUrl:string;userId:string;email:string}): Promise<void>;
}
interface Registry { version: number; selectedAccountId?: string; accounts: SavedOnlineSession[]; }
const STORE_VERSION = 2;
const MAX_ENCRYPTED_BYTES = 2 * 1024 * 1024;
export const loginAccountId = (value: {baseUrl:string;userId:string}) => JSON.stringify([value.baseUrl,value.userId]);
/** Only main opens DPAPI-protected refresh credentials. Passwords/bearers never enter this file. */
export function createOnlineSessionStore(): OnlineSessionStore {
  const target = () => join(app.getPath('userData'), 'prospector-refresh.enc');
  const secure = () => safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
  let active: string | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  function serialized<T>(action:()=>Promise<T>):Promise<T> {
    const next=queue.then(action);queue=next.catch(()=>{ /* The caller receives this failure; later independent writes must still run. */ });return next;
  }
  const empty=():Registry=>({version:STORE_VERSION,accounts:[]});
  const valid=(value:unknown):value is SavedOnlineSession=>!!value&&typeof value==='object'&&typeof (value as SavedOnlineSession).baseUrl==='string'&&typeof (value as SavedOnlineSession).userId==='string'&&typeof (value as SavedOnlineSession).refreshToken==='string';
  async function read():Promise<Registry> {
    if(!secure())return empty();
    try {
      const cipher=await readFile(target());if(cipher.length>MAX_ENCRYPTED_BYTES)throw new Error('Oversized encrypted store');
      const value=JSON.parse(safeStorage.decryptString(cipher));
      if(value?.version===STORE_VERSION&&Array.isArray(value.accounts)&&value.accounts.every(valid))return {version:STORE_VERSION,selectedAccountId:typeof value.selectedAccountId==='string'?value.selectedAccountId:undefined,accounts:value.accounts.map(clean)};
      if(valid(value))return {version:STORE_VERSION,selectedAccountId:loginAccountId(value),accounts:[clean(value)]};
      throw new Error('Invalid encrypted store');
    } catch(error) {
      if((error as NodeJS.ErrnoException).code!=='ENOENT')Log.warn('online.storage','无法读取系统加密登录信息，请重新登录');
      return empty();
    }
  }
  async function write(registry:Registry):Promise<void> {
    if(!secure())throw new Error('Secure storage unavailable');
    const file=target();await mkdir(dirname(file),{recursive:true});
    const temporary=`${file}.tmp`;await writeFile(temporary,safeStorage.encryptString(JSON.stringify(registry)),{mode:0o600});await rename(temporary,file);
  }
  // Whitelist fields: unknown password/bearer properties must never be persisted.
  function clean(value:SavedOnlineSession):SavedOnlineSession {
    return {baseUrl:value.baseUrl,userId:value.userId,refreshToken:value.refreshToken,email:value.email,autoLogin:value.autoLogin!==false,lastUsedAt:value.lastUsedAt??Date.now(),...(value.offlineAccess?{offlineAccess:value.offlineAccess,trustedPublicKey:value.trustedPublicKey,lastSeenAt:value.lastSeenAt}:{})};
  }
  return {
    load(accountId) { return serialized(async()=>{
      const registry=await read();const id=accountId??registry.selectedAccountId;active=id;
      const saved=registry.accounts.find(a=>loginAccountId(a)===id);
      if(!saved?.refreshToken || accountId===undefined&&saved.autoLogin===false)return null;
      if(accountId!==undefined){registry.selectedAccountId=id;await write(registry);}
      return {...saved};
    }); },
    save(value) { return serialized(async()=>{
      const registry=await read(),id=loginAccountId(value);const previous=registry.accounts.find(a=>loginAccountId(a)===id);
      const account=clean({...value,email:value.email??previous?.email});
      registry.accounts=registry.accounts.filter(a=>loginAccountId(a)!==id);registry.accounts.unshift(account);registry.selectedAccountId=id;
      await write(registry);active=id;
    }); },
    deselect() { return serialized(async()=>{
      const registry=await read();registry.selectedAccountId=undefined;
      await write(registry);active=undefined;
    }); },
    clear() { return serialized(async()=>{
      const registry=await read(),id=active??registry.selectedAccountId;
      registry.accounts=registry.accounts.map(a=>loginAccountId(a)===id?{baseUrl:a.baseUrl,userId:a.userId,refreshToken:'',email:a.email,autoLogin:false,lastUsedAt:a.lastUsedAt}:a);
      await write(registry);
    }); },
    list() { return serialized(async()=>{
      const registry=await read();return {selectedAccountId:registry.selectedAccountId,accounts:registry.accounts.map(a=>({accountId:loginAccountId(a),baseUrl:a.baseUrl,email:a.email??'',remembered:!!a.refreshToken,autoLogin:!!a.refreshToken&&a.autoLogin!==false,lastUsedAt:a.lastUsedAt??0})).sort((a,b)=>b.lastUsedAt-a.lastUsedAt)};
    }); },
    remove(accountId) { return serialized(async()=>{
      const registry=await read();registry.accounts=registry.accounts.filter(a=>loginAccountId(a)!==accountId);
      if(registry.selectedAccountId===accountId)registry.selectedAccountId=undefined;
      if(active===accountId)active=undefined;await write(registry);
    }); },
    record(value) { return serialized(async()=>{
      if(!secure())return; // Preset metadata is optional for a non-remembered login; never fall back to plaintext.
      const registry=await read(),id=loginAccountId(value);
      registry.accounts=registry.accounts.filter(a=>loginAccountId(a)!==id);registry.accounts.unshift({...value,refreshToken:'',autoLogin:false,lastUsedAt:Date.now()});registry.selectedAccountId=id;
      await write(registry);active=id;
    }); },
  };
}
