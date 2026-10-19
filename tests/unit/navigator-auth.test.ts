import { describe, it, expect, vi } from 'vitest';
import { NavigatorClient, validateNavigatorBase } from '../../src/main/services/navigator-auth.service';

const token = { access_token: 'access', refresh_token: 'refresh2', expires_in: 900, user: { user_id: 7, name: 'test', display_name: 'Test', role: 'sales' } };
function fixture(responses: Array<{status: number; body: any}>) {
  const request = vi.fn(async () => responses.shift()!);
  const saveRefresh = vi.fn(async () => {});
  const clearRefresh = vi.fn(async () => {});
  const client = new NavigatorClient({ baseUrl: () => 'https://navigator.test', request, loadRefresh: async () => 'refresh1', saveRefresh, clearRefresh, browserLogin: async () => ({code:'code',verifier:'verifier',redirectUri:'http://127.0.0.1:1234/navigator/callback'}), newQueryId: () => 'generated-id' });
  return {client, request, saveRefresh, clearRefresh};
}
describe('Navigator authorized client', () => {
  it('loads matching choices through the current device authorization', async () => {
    const choices={ports:[{n:'Santos',k:'pod'}],portGroups:[],carriers:[],routes:[]};
    const f=fixture([{status:200,body:{ok:true,data:token}},{status:200,body:{ok:true,data:choices}}]);
    expect(await f.client.options()).toEqual({ok:true,data:choices});
    expect(f.request.mock.calls[1]![0]).toBe('https://navigator.test/api/prospector/options');
    expect(f.request.mock.calls[1]![1].headers.Authorization).toBe('Bearer access');
  });
  it('loads a resolved encoded image URL exactly once through the authorized service', async () => {
    const f=fixture([{status:200,body:{ok:true,data:token}},{status:200,body:'data:image/png;base64,IMAGE'}]);
    expect(await f.client.image('/images/%40media_%E6%8A%A5%E4%BB%B7.png')).toEqual({ok:true,data:'data:image/png;base64,IMAGE'});
    expect(f.request.mock.calls[1]![0]).toBe('https://navigator.test/images/%40media_%E6%8A%A5%E4%BB%B7.png');
  });
  it('reports a missing image without invalidating a working account', async () => {
    const f=fixture([{status:200,body:{ok:true,data:token}},{status:404,body:null},{status:200,body:{ok:true,data:{user:token.user}}}]);
    expect(await f.client.image('missing.png')).toMatchObject({ok:false,code:'IMAGE_NOT_FOUND'});
    expect((await f.client.status()).data?.authenticated).toBe(true);
    expect(f.clearRefresh).not.toHaveBeenCalled();
  });
  it.each([
    ['', 'CONFIG_REQUIRED', '尚未配置 Navigator 地址'],
    ['http://203.0.113.10:8795', 'HTTPS_REQUIRED', '公网'],
  ])('reports address configuration failure before launching the browser (%s)',async(url,code,text)=>{
    const browserLogin=vi.fn();const request=vi.fn();
    const client=new NavigatorClient({baseUrl:()=>validateNavigatorBase(url,false),request,
      loadRefresh:async()=>null,saveRefresh:async()=>{},clearRefresh:async()=>{},browserLogin,newQueryId:()=> 'fixture'});
    expect(await client.login()).toMatchObject({ok:false,code,error:expect.stringContaining(text)});
    expect(await client.status()).toMatchObject({ok:false,code,error:expect.stringContaining(text)});
    expect(browserLogin).not.toHaveBeenCalled();expect(request).not.toHaveBeenCalled();
  });
  it.each([true,false])('supports trusted private LAN HTTP in packaged=%s', packaged => {
    for (const host of ['192.168.190.244','10.0.0.2','172.16.0.2','172.31.255.254','127.0.0.1','localhost','[::1]'])
      expect(validateNavigatorBase(`http://${host}:8795/`, packaged)).toBe(`http://${host}:8795`);
    for (const host of ['203.0.113.10','172.15.0.2','172.32.0.2','192.169.0.2','navigator.example','169.254.1.2'])
      expect(() => validateNavigatorBase(`http://${host}:8795`, packaged)).toThrow();
  });
  it('refreshes once then retries a query with identical identity', async () => {
    const f = fixture([{status:200,body:{ok:true,data:token}}, {status:401,body:{}}, {status:200,body:{ok:true,data:token}}, {status:200,body:{ok:true,data:[{id:1}],total:1}}]);
    expect((await f.client.query({pod:'SANTOS'}, 'same-id')).ok).toBe(true);
    const queries = f.request.mock.calls.filter(([path]) => path.includes('/api/rates?'));
    expect(queries).toHaveLength(2);
    expect(queries[0][0]).toBe(queries[1][0]);
    expect(queries[0][0]).toContain('query_id=same-id');
    expect(queries[0][0]).toContain('activity=intentional');
    expect(queries[0][1].headers.Authorization).toBe('Bearer access');
  });
  it('never falls back to a local mirror when unauthorized', async () => {
    const f = fixture([{status:401,body:{}}]);
    expect(await f.client.query({})).toMatchObject({ok:false,code:'AUTH_REQUIRED'});
    expect(f.clearRefresh).toHaveBeenCalled();
  });
  it('accepts the existing flat query envelope without changing source rows', async () => {
    const f = fixture([{status:200,body:{ok:true,data:token}}, {status:200,body:{rows:[{id:4,price_20:88}],total:9,limit:1,offset:0}}]);
    expect(await f.client.query({limit:1})).toMatchObject({ok:true,data:{rows:[{id:4,price_20:88}],total:9}});
  });
  it('serializes concurrent refreshes and returns status without credentials', async () => {
    const f = fixture([{status:200,body:{ok:true,data:token}}, {status:200,body:{ok:true,data:{user:token.user}}}, {status:200,body:{ok:true,data:{user:token.user}}}]);
    const results = await Promise.all([f.client.status(), f.client.status()]);
    expect(f.request.mock.calls.filter(([path]) => path.endsWith('/token'))).toHaveLength(1);
    expect(JSON.stringify(results)).not.toContain('refresh2');
    expect(JSON.stringify(results)).not.toContain('access_token');
  });
  it('clears local authorization even if remote logout fails', async () => {
    const f = fixture([{status:200,body:{ok:true,data:token}}, {status:500,body:{}}]);
    await f.client.logout();
    expect(f.clearRefresh).toHaveBeenCalled();
  });
  it('discards an in-flight query once logout invalidates authorization', async () => {
    let release: (response:any) => void = () => {};
    const f = fixture([{status:200,body:{ok:true,data:token}},{status:200,body:{ok:true,data:{user:token.user}}}]);
    await f.client.status();
    f.request.mockImplementation(async (path) => path.includes('/api/rates?') ? new Promise(resolve => {release=resolve;}) : {status:200,body:{ok:true}});
    const query = f.client.query({pod:'SANTOS'});
    await Promise.resolve();
    await f.client.logout();
    release({status:200,body:{rows:[{price:100}],total:1}});
    expect(await query).toMatchObject({ok:false,code:'AUTH_REQUIRED'});
  });
  it('never exposes token-exchange exception details', async () => {
    const f = fixture([]);
    f.request.mockRejectedValue(new Error('secret-refresh-token'));
    expect(JSON.stringify(await f.client.status())).not.toContain('secret-refresh-token');
  });
  it('exchanges the bound browser callback with PKCE and saves only refresh credentials', async () => {
    const f = fixture([{status:200,body:{ok:true,data:token}}, {status:200,body:{ok:true,data:{user:token.user}}}]);
    expect(await f.client.login()).toMatchObject({ok:true,data:{authenticated:true}});
    const exchange = f.request.mock.calls[0]!;
    expect(JSON.parse(exchange[1].body!)).toEqual({grant_type:'authorization_code',client_id:'prospector',code:'code',code_verifier:'verifier',redirect_uri:'http://127.0.0.1:1234/navigator/callback'});
    expect(f.saveRefresh).toHaveBeenCalledWith('https://navigator.test','refresh2');
  });
  it('retries authorization only once when the new token is also rejected', async () => {
    const f = fixture([{status:200,body:{ok:true,data:token}},{status:401,body:{}},{status:200,body:{ok:true,data:token}},{status:401,body:{}}]);
    expect(await f.client.query({})).toMatchObject({ok:false,code:'AUTH_REQUIRED'});
    expect(f.request.mock.calls.filter(([path]) => path.includes('/api/rates?'))).toHaveLength(2);
    expect(f.clearRefresh).toHaveBeenCalled();
  });
  it.each(['image','status'])('discards old-account pending %s response after another account logs in',async(kind)=>{
    const f=fixture([{status:200,body:{ok:true,data:token}},{status:200,body:{ok:true,data:{user:token.user}}}]);
    await f.client.status();
    let release:(response:any)=>void=()=>{};
    let pending=true;
    const newToken={...token,user:{...token.user,user_id:8,name:'new-user'}};
    f.request.mockImplementation(async(path)=>{
      if (pending && (path.includes('/images/') || path.endsWith('/me'))) {
        pending=false;return new Promise(resolve=>{release=resolve;});
      }
      if(path.endsWith('/token')) return {status:200,body:{ok:true,data:newToken}};
      return {status:200,body:{ok:true,data:{user:newToken.user}}};
    });
    const prior=kind==='image'?f.client.image('card.png'):f.client.status();
    await Promise.resolve();
    expect(await f.client.login()).toMatchObject({ok:true,data:{user:{user_id:8}}});
    release({status:200,body:kind==='image'?'data:image/png;base64,OLD':{ok:true,data:{user:token.user}}});
    const result=await prior;
    expect(JSON.stringify(result)).not.toContain('OLD');
    expect(result).not.toMatchObject({data:{user:{user_id:7}}});
    expect(await f.client.status()).toMatchObject({ok:true,data:{user:{user_id:8}}});
  });
  it('refreshes an expired access token to revoke the device refresh grant on logout',async()=>{
    const f=fixture([{status:200,body:{ok:true,data:token}},{status:200,body:{ok:true,data:{user:token.user}}},{status:401,body:{}},{status:200,body:{ok:true,data:token}},{status:200,body:{ok:true}}]);
    await f.client.status();
    expect(await f.client.logout()).toEqual({ok:true});
    expect(f.request.mock.calls.filter(([path])=>path.endsWith('/logout'))).toHaveLength(2);
    expect(f.clearRefresh).toHaveBeenCalled();
  });
  it.each([7,8])('a late failed refresh cannot clear a newer browser grant for user %s', async(userId)=>{
    const f=fixture([]);
    let release!: (response:any)=>void;
    const newer={...token,access_token:'new-access',refresh_token:'new-refresh',user:{...token.user,user_id:userId}};
    f.request.mockImplementation(async(path,init)=>{
      if(path.endsWith('/token') && JSON.parse(init.body!).grant_type==='refresh_token') return new Promise(resolve=>{release=resolve;});
      return {status:200,body:path.endsWith('/token')?{ok:true,data:newer}:{ok:true,data:{user:newer.user}}};
    });
    const prior=f.client.status();
    await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
    expect((await f.client.login()).data?.authenticated).toBe(true);
    release({status:400,body:{ok:false}});await prior;
    expect(f.clearRefresh).not.toHaveBeenCalled();
    expect((await f.client.status()).data?.user?.user_id).toBe(userId);
  });
  it('logout finishing after a new login never clears the new stored credential',async()=>{
    const f=fixture([{status:200,body:{ok:true,data:token}},{status:200,body:{ok:true,data:{user:token.user}}}]);
    await f.client.status();
    let release!:(response:any)=>void;
    const newer={...token,user:{...token.user,user_id:8}};
    f.request.mockImplementation(async(path)=>{
      if(path.endsWith('/logout'))return new Promise(resolve=>{release=resolve;});
      return {status:200,body:path.endsWith('/token')?{ok:true,data:newer}:{ok:true,data:{user:newer.user}}};
    });
    const logout=f.client.logout();await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
    expect((await f.client.login()).data?.authenticated).toBe(true);
    const clears=f.clearRefresh.mock.calls.length;
    release({status:200,body:{ok:true}});await logout;
    expect(f.clearRefresh).toHaveBeenCalledTimes(clears);
    expect((await f.client.status()).data?.user?.user_id).toBe(8);
  });
});
