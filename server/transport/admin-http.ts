import type { IncomingMessage,ServerResponse } from 'node:http';
import { ADMIN_ROUTES,ADMIN_LIMITS } from '../core/admin';
import type { OperationsCheck } from '../core/management-dashboard';
import type { NavigatorDashboard } from '../core/navigator';
import type { OnlineConfig,TokenPort,LoginGate } from '../core/auth';
import { failure,success } from '../core/crm';
import type { AuthService } from '../services/auth';
import type { AdminService } from '../services/admin';
import type {PasswordChangeService} from '../services/password-change';
import type { createManagementDashboardService } from '../services/management-dashboard';
import { ADMIN_DATA_BROWSER_LIMITS,type AdminDataDirection } from '../core/admin-data-browser';
import type { createAdminDataBrowserService } from '../services/admin-data-browser';
import { body,send,type BrowserHandler } from './http';

const COOKIE='milogin_admin';
const TOKEN=/^[A-Za-z0-9_-]{43}$/;
const CSRF=/^[a-f0-9]{64}$/;
function cookie(request:IncomingMessage):string {
 const matches=(request.headers.cookie??'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(`${COOKIE}=`));
 const value=matches.length===1?matches[0]!.slice(COOKIE.length+1):'';return TOKEN.test(value)?value:'';
}
function sameOrigin(request:IncomingMessage,config:OnlineConfig):boolean {
 return request.headers.origin===(config.public_origin ?? `http://${request.headers.host}`) && request.headers['sec-fetch-site']!=='cross-site';
}
function record(value:unknown):value is Record<string,unknown> {return !!value&&typeof value==='object'&&!Array.isArray(value);}
async function navigatorDashboard(config: OnlineConfig, token: string) {
 try {
  const response=await fetch(`${config.navigator_url.replace(/\/$/,'')}/api/center/navigator/dashboard`,{
   headers:{Accept:'application/json',Authorization:`Bearer ${token}`},
   signal:AbortSignal.timeout(config.request_timeout_seconds*1000),
  });
  const payload=await response.json() as {ok?:boolean;data?:Omit<NavigatorDashboard,'entryUrl'>;error?:unknown};
  if(response.ok&&payload.ok===true&&payload.data) return success({...payload.data,entryUrl:config.navigator_entry_url});
  if(response.status===401) return failure('UNAUTHORIZED','Navigator 登录状态无效');
  if(response.status===403) return failure('FORBIDDEN','当前中心账号没有 Navigator 管理权限');
  return failure('UNAVAILABLE','Navigator 服务暂不可用');
 } catch { return failure('UNAVAILABLE','Navigator 服务暂不可用'); }
}
async function navigatorHealth(config: OnlineConfig):Promise<OperationsCheck> {
 try {
  const response=await fetch(`${config.navigator_url.replace(/\/$/,'')}/api/health/live`,{
   headers:{Accept:'application/json'},signal:AbortSignal.timeout(config.request_timeout_seconds*1000),
  });
  const payload=await response.json() as {ok?:boolean;data?:{status?:string;backend?:string}};
  if(response.ok&&payload.ok===true&&payload.data?.status==='ok')return {id:'navigator',label:'Navigator',state:'healthy',value:'正常',valueLabel:'服务状态',detail:`${payload.data.backend==='postgres'?'PostgreSQL':'业务'}后端可用`};
  return {id:'navigator',label:'Navigator',state:'offline',value:'异常',valueLabel:'服务状态',detail:'健康接口返回异常'};
 } catch {
  // Upstream details stay out of the browser; the read-only check records the outage itself.
  return {id:'navigator',label:'Navigator',state:'offline',value:'离线',valueLabel:'服务状态',detail:'暂无法连接 Navigator 服务'};
 }
}
export function createAdminHandler(auth:AuthService,admin:AdminService,tokens:TokenPort,gate:LoginGate,config:OnlineConfig,staticHandler:BrowserHandler,passwordChange?:PasswordChangeService,dashboard?:ReturnType<typeof createManagementDashboardService>,dataBrowser?:ReturnType<typeof createAdminDataBrowserService>):BrowserHandler {
 const cookieFlags=`HttpOnly; SameSite=Strict; Path=/`+(config.test_mode||config.local_http?'':'; Secure');
 return async(request,response)=>{
  response.setHeader('Referrer-Policy','no-referrer');
  response.setHeader('X-Frame-Options','DENY');
  response.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const url=new URL(request.url??'/',`http://${request.headers.host}`),path=url.pathname,method=request.method;
  if(!path.startsWith('/admin-api/')) {
   if(method!=='GET'&&method!=='HEAD'){send(response,failure('NOT_FOUND','页面不存在'));return;}
   await staticHandler(request,response);return;
  }
  const token=cookie(request),csrf=token?tokens.hash(`csrf:${token}`):'',address=request.socket.remoteAddress??'unknown';
  if(request.headers.origin && !sameOrigin(request,config) || request.headers['sec-fetch-site']==='cross-site'){send(response,failure('FORBIDDEN','不接受跨站管理请求'));return;}
  if(method==='POST'&&!sameOrigin(request,config)){send(response,failure('FORBIDDEN','管理操作必须来自同源页面'));return;}
  if(method==='POST' && path!==ADMIN_ROUTES.login && path!==ADMIN_ROUTES.consume) {
   const submitted=request.headers['x-csrf-token'];
   if(!token||typeof submitted!=='string'||!CSRF.test(submitted)||submitted!==csrf){send(response,failure('FORBIDDEN','管理操作校验失败，请刷新页面'));return;}
  }
  if(method==='POST'&&path===ADMIN_ROUTES.login){
   const input=await body(request,config.request_body_bytes);if(!input.ok){send(response,input);return;}
   const email=record(input.data)&&typeof input.data.email==='string'?input.data.email.trim().toLowerCase():'invalid';
   if(!gate.allow(`browser-login:${email}`,address)){send(response,failure('RATE_LIMITED','登录尝试过多，请稍后重试'));return;}
   const result=await auth.login(input.data,'browser');
   if(!result.ok){send(response,result);return;}
   response.setHeader('Set-Cookie',`${COOKIE}=${result.data.token}; ${cookieFlags}; Max-Age=${config.session_ttl_seconds}`);
   send(response,success({identity:result.data.identity,expiresAt:result.data.expiresAt,csrf:tokens.hash(`csrf:${result.data.token}`)}));return;
  }
  if(method==='POST'&&path===ADMIN_ROUTES.consume){
   if(!gate.allow('challenge-consume',address)){send(response,failure('RATE_LIMITED','密码设置尝试过多'));return;}
   const input=await body(request,config.request_body_bytes);send(response,input.ok?await admin.consume(input.data):input);return;
  }
  if(!token){send(response,failure('UNAUTHORIZED','请先登录管理平台'));return;}
  if(method==='GET'&&path===ADMIN_ROUTES.me){const result=await auth.me(token,'browser');send(response,result.ok?success({identity:result.data,csrf}):result);return;}
  if(method==='POST'&&path===ADMIN_ROUTES.logout){const result=await auth.logout(token,'browser');response.setHeader('Set-Cookie',`${COOKIE}=; ${cookieFlags}; Max-Age=0`);send(response,result);return;}
  if(method==='POST'&&path===ADMIN_ROUTES.password){
   if(!passwordChange){send(response,failure('UNAVAILABLE','改密服务不可用'));return;}
   if(!gate.allow(`password-change:${tokens.hash(token)}`,address)){send(response,failure('RATE_LIMITED','改密尝试过多'));return;}
   const input=await body(request,config.request_body_bytes);const result=input.ok?await passwordChange.change(token,input.data):input;
   if(result.ok)response.setHeader('Set-Cookie',`${COOKIE}=; ${cookieFlags}; Max-Age=0`);
   send(response,result);return;
  }
  if(method==='GET'&&path===ADMIN_ROUTES.users){
   const limit=Number(url.searchParams.get('limit')??ADMIN_LIMITS.page),offset=Number(url.searchParams.get('offset')??0);
   if(!Number.isSafeInteger(limit)||limit<1||limit>ADMIN_LIMITS.pageMax||!Number.isSafeInteger(offset)||offset<0){send(response,failure('INVALID_INPUT','分页参数无效'));return;}
   send(response,await admin.users(token,{search:url.searchParams.get('search')??'',limit,offset,...(url.searchParams.has('productId')?{productId:url.searchParams.get('productId')}: {}),...(url.searchParams.has('state')?{state:url.searchParams.get('state')}: {})}));return;
  }
  if(method==='GET'&&path===ADMIN_ROUTES.products){send(response,await admin.products(token));return;}
  if(method==='GET'&&path===ADMIN_ROUTES.dashboard){send(response,dashboard?await dashboard.dashboard(token):failure('UNAVAILABLE','数据看板暂不可用'));return;}
  if(method==='GET'&&path===ADMIN_ROUTES.operations){
   if(!dashboard){send(response,failure('UNAVAILABLE','系统运行服务暂不可用'));return;}
   const result=await dashboard.operations(token);
   if(!result.ok){send(response,result);return;}
   send(response,success({...result.data,checks:[...result.data.checks,await navigatorHealth(config)]}));return;
  }
  if(method==='GET'&&path===ADMIN_ROUTES.data){
   if(!dataBrowser){send(response,failure('UNAVAILABLE','数据浏览服务暂不可用'));return;}
   if(!url.searchParams.has('table')){send(response,await dataBrowser.tables(token));return;}
   const limit=Number(url.searchParams.get('limit')??ADMIN_DATA_BROWSER_LIMITS.page),offset=Number(url.searchParams.get('offset')??0);
   if(!Number.isSafeInteger(limit)||limit<1||limit>ADMIN_DATA_BROWSER_LIMITS.pageMax||!Number.isSafeInteger(offset)||offset<0){send(response,failure('INVALID_INPUT','分页参数无效'));return;}
   const rawDirection=url.searchParams.get('direction'),direction=rawDirection===null?undefined:rawDirection as AdminDataDirection;
   if(direction!==undefined&&direction!=='asc'&&direction!=='desc'){send(response,failure('INVALID_INPUT','排序方向无效'));return;}
   const sort=url.searchParams.get('sort');
   send(response,await dataBrowser.page(token,{table:url.searchParams.get('table')??'',search:url.searchParams.get('search')??'',limit,offset,...(sort?{sort}:{}),...(direction?{direction}:{})}));return;
  }
  if(method==='GET'&&path===ADMIN_ROUTES.navigatorDashboard){send(response,await navigatorDashboard(config,token));return;}
  if(method==='GET'&&path===ADMIN_ROUTES.sessions){send(response,await admin.sessions(token,url.searchParams.get('userId')??''));return;}
  if(method==='GET'&&path===ADMIN_ROUTES.audit){send(response,await admin.audit(token,url.searchParams.get('productId')??undefined,url.searchParams.get('userId')??undefined));return;}
  if(method==='POST'&&path===ADMIN_ROUTES.mutate){
   if(!gate.allow(`management:${tokens.hash(token)}`,address)){send(response,failure('RATE_LIMITED','重新认证尝试过多'));return;}
   const input=await body(request,config.request_body_bytes);if(!input.ok){send(response,input);return;}
   if(!record(input.data)||Object.keys(input.data).some(k=>k!=='command'&&k!=='password')){send(response,failure('INVALID_INPUT','管理请求无效'));return;}
   if(record(input.data.command)&&input.data.command.action==='challenge.issue'&&!config.test_mode){send(response,failure('FORBIDDEN','账号激活链接仅用于本机开通流程'));return;}
   send(response,await admin.mutate(token,input.data.command,input.data.password));return;
  }
  send(response,failure('NOT_FOUND','管理接口不存在'));
 };
}
