import type { NavigatorResult, NavigatorStatus, NavigatorUser, NavigatorQuery, NavigatorOptions } from '../../shared/navigator';
import { NAVIGATOR_CLIENT_ID } from '../../shared/navigator';

interface Token { access_token: string; refresh_token: string; expires_in: number; user: NavigatorUser }
export interface NavigatorPorts {
  baseUrl(): string;
  request(path: string, init: { method?: string; headers: Record<string,string>; body?: string }): Promise<{ status: number; body: any }>;
  loadRefresh(base: string): Promise<string | null>;
  saveRefresh(base: string, token: string): Promise<void>;
  clearRefresh(): Promise<void>;
  browserLogin(base: string): Promise<{code: string; verifier: string; redirectUri: string}>;
  newQueryId(): string;
  identityChanged?(): void;
}
export class NavigatorConfigurationError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export function validateNavigatorBase(value: string, _packaged: boolean): string {
  if (!value?.trim()) throw new NavigatorConfigurationError('CONFIG_REQUIRED', '尚未配置 Navigator 地址，请在设置中的运价台账填写服务地址');
  let url: URL;
  try { url = new URL(value); }
  catch { throw new NavigatorConfigurationError('CONFIG_INVALID', 'Navigator 地址格式无效，请在设置中填写完整服务地址'); } // Never return the supplied URL; it may contain credentials.
  const octets = url.hostname.split('.').map(Number);
  const ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) && octets.every(n => n >= 0 && n <= 255);
  // Literal RFC1918 addresses avoid treating arbitrary DNS names as trusted LAN.
  const privateHost = ['localhost','[::1]'].includes(url.hostname) || (ipv4 && (
    octets[0] === 127 || octets[0] === 10 ||
    (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
    (octets[0] === 192 && octets[1] === 168)));
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new NavigatorConfigurationError('CONFIG_INVALID', 'Navigator 地址仅填写服务网址，不含账号、密码、查询参数或页面路径');
  if (!(url.protocol === 'https:' || (privateHost && url.protocol === 'http:')))
    throw new NavigatorConfigurationError('HTTPS_REQUIRED', '公网 Navigator 地址必须使用 HTTPS；HTTP 仅支持私有局域网 IP 或本机地址');
  return url.origin;
}
const authRequired = (): NavigatorResult<never> => ({ok:false,code:'AUTH_REQUIRED',error:'请先登录并授权 Navigator'});

/** Pure coordinator: network, browser and encrypted storage are injected ports. */
export class NavigatorClient {
  private access: string | null = null;
  private base: string | null = null;
  private refreshing: Promise<boolean> | null = null;
  private generation = 0;
  private userId: string | null = null;
  private loginPending: Promise<NavigatorResult<NavigatorStatus>> | null = null;
  private credentialWork: Promise<void> = Promise.resolve();
  constructor(private readonly ports: NavigatorPorts) {}
  private store<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.credentialWork.then(operation);
    // Keep the storage queue usable after a failed operation; the caller still receives its error.
    this.credentialWork = work.then(() => undefined, () => undefined);
    return work;
  }
  hasAuthorization(): boolean { return this.access !== null; }
  private async clear(): Promise<void> {
    this.generation++;
    this.access = null;
    this.base = null;
    this.userId = null;
    this.ports.identityChanged?.();
    const generation = this.generation;
    await this.store(async () => { if (generation === this.generation) await this.ports.clearRefresh(); });
  }
  private async accept(token: Token, base: string, generation: number, newGrant = false): Promise<boolean> {
    if (generation !== this.generation) return false;
    if (!token?.access_token || !token.refresh_token || !token.user) throw new Error('Invalid authorization response');
    await this.store(async () => {
      if (generation === this.generation) await this.ports.saveRefresh(base, token.refresh_token);
    });
    // A newer logout/login owns storage cleanup; never erase its credentials.
    if (generation !== this.generation) return false;
    this.access = token.access_token;
    this.base = base;
    const userId = String(token.user.user_id);
    if (newGrant || this.userId !== userId) {this.userId = userId;this.generation++;this.ports.identityChanged?.();}
    return true;
  }
  private async refresh(): Promise<boolean> {
    if (this.refreshing) return this.refreshing;
    const generation = this.generation;
    this.refreshing = (async () => {
      const base = this.ports.baseUrl();
      const refresh = await this.store(() => this.ports.loadRefresh(base));
      if (!refresh || generation !== this.generation) return false;
      const response = await this.ports.request(`${base}/api/prospector/token`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({grant_type:'refresh_token',refresh_token:refresh,client_id:NAVIGATOR_CLIENT_ID})});
      if (response.status !== 200 || !response.body?.ok) {
        if (generation === this.generation && (response.status === 400 || response.status === 401 || response.status === 403)) await this.clear();
        return false;
      }
      return this.accept(response.body.data, base, generation);
    })().finally(() => {this.refreshing = null;});
    return this.refreshing;
  }
  private async authorized(path: string, method = 'GET'): Promise<{status:number;body:any} | null> {
    const base = this.ports.baseUrl();
    if (this.base && this.base !== base) await this.clear();
    if (!this.access && !await this.refresh()) return null;
    const generation = this.generation;
    const access = this.access;
    let response = await this.ports.request(`${base}${path}`, {method,headers:{Authorization:`Bearer ${access}`}});
    if (generation !== this.generation) return null;
    if (response.status === 401) {
      // Concurrent failures share the refresh, or use the token another request already refreshed.
      if (this.access === access && !await this.refresh()) return null;
      response = await this.ports.request(`${base}${path}`, {method,headers:{Authorization:`Bearer ${this.access}`}});
    }
    if (generation !== this.generation) return null;
    if (response.status === 401 || response.status === 403) { await this.clear(); return null; }
    return response;
  }
  async status(): Promise<NavigatorResult<NavigatorStatus>> {
    try {
      const baseUrl = this.ports.baseUrl();
      const response = await this.authorized('/api/prospector/me');
      if (!response) return {ok:true,data:{authenticated:false,baseUrl}};
      if (response.status !== 200 || !response.body?.ok) return {ok:false,error:'Navigator 暂时无法验证账号'};
      const user = response.body.data.user as NavigatorUser;
      if (!user?.user_id) return {ok:false,error:'Navigator 账号验证响应无效'};
      const userId = String(user.user_id);
      if (this.userId !== userId) {this.userId = userId;this.generation++;this.ports.identityChanged?.();}
      return {ok:true,data:{authenticated:true,baseUrl,user}};
    } catch (error) {
      if (error instanceof NavigatorConfigurationError) return {ok:false,code:error.code,error:error.message};
      return {ok:false,code:'CONNECTION_FAILED',error:'无法连接 Navigator，请检查服务地址和网络'};
    } // Never forward server/network exceptions containing credentials.
  }
  async login(): Promise<NavigatorResult<NavigatorStatus>> {
    if (this.loginPending) return this.loginPending;
    this.loginPending = this.performLogin().finally(() => {this.loginPending = null;});
    return this.loginPending;
  }
  private async performLogin(): Promise<NavigatorResult<NavigatorStatus>> {
    let stage: 'config' | 'browser' | 'exchange' | 'storage' = 'config';
    try {
      const base = this.ports.baseUrl();
      const generation = this.generation;
      stage = 'browser';
      const flow = await this.ports.browserLogin(base);
      stage = 'exchange';
      const response = await this.ports.request(`${base}/api/prospector/token`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({grant_type:'authorization_code',client_id:NAVIGATOR_CLIENT_ID,code:flow.code,code_verifier:flow.verifier,redirect_uri:flow.redirectUri})});
      if (response.status !== 200 || !response.body?.ok) return {ok:false,code:'AUTH_REJECTED',error:'Navigator 拒绝了授权，请检查账号状态和服务版本后重新登录'};
      stage = 'storage';
      if (!await this.accept(response.body.data,base,generation,true)) return authRequired();
      return this.status();
    } catch (error) {
      if (error instanceof NavigatorConfigurationError) return {ok:false,code:error.code,error:error.message};
      if (stage === 'exchange') return {ok:false,code:'CONNECTION_FAILED',error:'无法连接 Navigator 授权接口，请检查服务地址与运行版本'};
      if (stage === 'storage') return {ok:false,code:'SECURE_STORAGE_FAILED',error:'无法安全保存 Navigator 授权，请检查系统凭据存储'};
      if (stage === 'browser' && error instanceof Error) {
        if (error.message === 'Authorization timeout') return {ok:false,code:'AUTH_TIMEOUT',error:'等待浏览器授权超时，请完成 Navigator 登录并点击授权后重试'};
        if (error.message === 'Browser launch failed') return {ok:false,code:'BROWSER_FAILED',error:'无法打开系统浏览器，请检查默认浏览器设置'};
        if (error.message === 'Loopback callback failed' || error.message === 'Invalid callback address') return {ok:false,code:'CALLBACK_FAILED',error:'无法建立本机授权回调，请检查本机端口访问权限'};
      }
      return {ok:false,code:'AUTH_INCOMPLETE',error:'Navigator 授权未完成，请在浏览器中登录并允许授权'};
    } // Only known fixed messages cross IPC; never expose callback, token or network exception contents.
  }
  async logout(): Promise<NavigatorResult<void>> {
    let access = this.access;
    let base: string | null = this.base;
    // Immediately invalidate in-flight requests before reading or revoking persisted credentials.
    this.generation++;
    this.access = null;
    this.base = null;
    this.userId = null;
    this.ports.identityChanged?.();
    const generation = this.generation;
    try {
      base ??= this.ports.baseUrl();
      const refresh = await this.store(async () => {
        if (generation !== this.generation) return null;
        const value = await this.ports.loadRefresh(base!);
        await this.ports.clearRefresh();
        return value;
      });
      if (!access && refresh) {
        const response = await this.ports.request(`${base}/api/prospector/token`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({grant_type:'refresh_token',refresh_token:refresh,client_id:NAVIGATOR_CLIENT_ID})});
        if (response.status === 200 && response.body?.ok) access = response.body.data.access_token;
        else if (response.status !== 401 && response.status !== 403) throw new Error('Remote revoke failed');
      }
      if (access && base) {
        let response = await this.ports.request(`${base}/api/prospector/logout`,{method:'POST',headers:{Authorization:`Bearer ${access}`}});
        if (response.status === 401 && refresh) {
          const rotated = await this.ports.request(`${base}/api/prospector/token`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({grant_type:'refresh_token',refresh_token:refresh,client_id:NAVIGATOR_CLIENT_ID})});
          if (rotated.status === 200 && rotated.body?.ok) {
            response = await this.ports.request(`${base}/api/prospector/logout`,{method:'POST',headers:{Authorization:`Bearer ${rotated.body.data.access_token}`}});
            if (response.status !== 200) throw new Error('Remote revoke failed');
          } else if (rotated.status !== 401 && rotated.status !== 403) throw new Error('Remote revoke failed');
        } else if (response.status !== 200 && response.status !== 401) throw new Error('Remote revoke failed');
      }
      return {ok:true};
    } catch {return {ok:false,error:'本机已退出；远端撤销失败，请在 Navigator 检查设备授权'};}
    finally {await this.store(async () => {if (generation === this.generation) await this.ports.clearRefresh();});}
  }
  async requireAuthorization(): Promise<NavigatorResult<NavigatorStatus>> {
    const status = await this.status();
    return status.ok && status.data?.authenticated ? status : authRequired();
  }
  async query(filters: Record<string,unknown>, queryId = this.ports.newQueryId(), kind: 'rates'|'space' = 'rates'): Promise<NavigatorResult<NavigatorQuery>> {
    try {
      const params = new URLSearchParams();
      for (const [key,value] of Object.entries(filters)) {
        if (!['query_id','activity','_client_app','user_id','username','source'].includes(key) && value != null) params.set(key,Array.isArray(value) ? JSON.stringify(value) : String(value));
      }
      params.set('query_id',queryId); params.set('activity','intentional');
      const response = await this.authorized(`/api/${kind}?${params}`);
      if (!response) return authRequired();
      if (response.status !== 200 || response.body?.ok === false) return {ok:false,error:'Navigator 查价失败'};
      const data = response.body.data ?? response.body;
      const rows = Array.isArray(data) ? data : data?.rows ?? data?.items ?? [];
      return {ok:true,data:{rows,total:Number(response.body.total ?? data?.total ?? rows.length),queryId}};
    } catch { return {ok:false,error:'Navigator 查价连接失败'}; } // Sanitized error, no local quote fallback.
  }
  async image(name: string): Promise<NavigatorResult<string>> {
    if (typeof name !== 'string') return {ok:false,code:'IMAGE_INVALID',error:'图片名称无效'};
    // URL references only identify a file on the configured Navigator; never fetch their origin.
    if (name.startsWith('/images/') || /^https?:\/\//i.test(name)) {
      try {
        const reference = new URL(name, 'https://navigator.invalid');
        if (reference.username || reference.password || reference.search || reference.hash || !reference.pathname.startsWith('/images/')) throw new Error('Invalid image reference');
        name = decodeURIComponent(reference.pathname.slice('/images/'.length));
      } catch { return {ok:false,code:'IMAGE_INVALID',error:'图片地址无效'}; } // Malformed references never reach the network.
    }
    if (!name || /[/\\]|\.\.|[?#\x00-\x1f]/.test(name)) return {ok:false,code:'IMAGE_INVALID',error:'图片名称无效'};
    try {
      const response = await this.authorized(`/images/${encodeURIComponent(name)}`);
      if (!response) return authRequired();
      if (response.status === 404) return {ok:false,code:'IMAGE_NOT_FOUND',error:'Navigator 原始截图文件不存在或当前账号无权访问'};
      if (response.body?.code === 'UNSUPPORTED_IMAGE') return {ok:false,code:'IMAGE_UNSUPPORTED',error:'来源附件不是支持的图片格式，无法显示截图'};
      return response.status === 200 && typeof response.body === 'string' && /^data:image\//.test(response.body)
        ? {ok:true,data:response.body} : {ok:false,error:'无法读取 Navigator 图片'};
    } catch {return {ok:false,error:'Navigator 图片连接失败'};} // Do not expose transport errors.
  }
  async options(): Promise<NavigatorResult<NavigatorOptions>> {
    try {
      const response = await this.authorized('/api/prospector/options');
      if (!response) return authRequired();
      if (response.status !== 200 || !response.body?.ok || !response.body.data) return {ok:false,error:'无法读取 Navigator 匹配候选'};
      return {ok:true,data:response.body.data};
    } catch {return {ok:false,error:'Navigator 匹配候选连接失败'};} // Never expose transport or token details.
  }
}
