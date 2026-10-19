import { app, safeStorage, shell, BrowserWindow } from 'electron';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config';
import { NavigatorClient, validateNavigatorBase } from '../services/navigator-auth.service';
import { browserAuthorization } from './navigator-browser.adapter';
import { Log } from '../logger';
import { EVENTS } from '../events';
const REQUEST_TIMEOUT_SECONDS = 20;
const MILLISECONDS_PER_SECOND = 1000;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const file = () => path.join(app.getPath('userData'),'navigator-refresh.enc');
let authorizationEpoch = 0;
const identityListeners = new Set<() => void>();
export const navigatorAuthorizationEpoch = () => authorizationEpoch;
export function onNavigatorIdentityChanged(listener: () => void): () => void {
  identityListeners.add(listener);
  return () => {identityListeners.delete(listener);};
}
const client = new NavigatorClient({
  identityChanged() {
    authorizationEpoch++;
    for (const listener of identityListeners) {
      try {listener();} catch {Log.error('navigator','账号现场清理回调失败');}
    }
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(EVENTS.NAVIGATOR_IDENTITY_CHANGED,{epoch:authorizationEpoch});
    }
  },
  baseUrl: () => validateNavigatorBase(process.env.RATES_REMOTE_URL || loadConfig().rates?.url || '',app.isPackaged),
  async loadRefresh(base) {
    try {
      if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') return null;
      const value = JSON.parse(safeStorage.decryptString(await fs.readFile(file())));
      return value.base === base && typeof value.refresh === 'string' ? value.refresh : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') Log.warn('navigator','无法读取系统加密授权，请重新登录');
      return null;
    }
  },
  async saveRefresh(base,refresh) {
    if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw new Error('Secure storage unavailable');
    const target = file();
    await fs.mkdir(path.dirname(target),{recursive:true});
    const temporary = `${target}.tmp`;
    await fs.writeFile(temporary,safeStorage.encryptString(JSON.stringify({base,refresh})),{mode:0o600});
    await fs.rename(temporary,target);
  },
  async clearRefresh() { await fs.rm(file(),{force:true}); },
  browserLogin: (base) => browserAuthorization(base,(url) => shell.openExternal(url)),
  newQueryId: randomUUID,
  async request(url,init) {
    const response = await fetch(url,{...init,redirect:'error',signal:AbortSignal.timeout(REQUEST_TIMEOUT_SECONDS*MILLISECONDS_PER_SECOND)});
    if (new URL(url).pathname.startsWith('/images/')) {
      const mime = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
      if (response.status !== 200) return {status:response.status,body:null};
      if (!/^image\/(png|jpeg|gif|webp|bmp)$/.test(mime)) return {status:response.status,body:{code:'UNSUPPORTED_IMAGE'}};
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (!response.body) return {status:response.status,body:null};
      const reader = response.body.getReader();
      try {
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          bytes += item.value.length;
          if (bytes > MAX_IMAGE_BYTES) {await reader.cancel();throw new Error('Image too large');}
          chunks.push(item.value);
        }
      } finally {reader.releaseLock();}
      return {status:response.status,body:`data:${mime};base64,${Buffer.concat(chunks).toString('base64')}`};
    }
    return {status:response.status,body:await response.json()};
  },
});
export const navigatorStatus = () => client.status();
export const navigatorHasAuthorization = () => client.hasAuthorization();
export const loginNavigator = () => client.login();
export const logoutNavigator = () => client.logout();
export const requireNavigatorAuthorization = () => client.requireAuthorization();
export const queryNavigatorRates = (filters:Record<string,unknown>,queryId?:string,kind:'rates'|'space' = 'rates') => client.query(filters,queryId,kind);
export const fetchNavigatorImage = (name:string) => client.image(name);
export const fetchNavigatorOptions = () => client.options();
