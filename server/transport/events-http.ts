import {failure} from '../core/crm';
import {NOTIFICATION_LIMITS,NOTIFICATION_ROUTES} from '../core/notifications';
import type {NotificationService} from '../services/notifications';
import {send,type BrowserHandler} from './http';
export function createEventsHandler(service:NotificationService):BrowserHandler{
 let streams=0;
 return async(request,response)=>{
  const url=new URL(request.url??'/','http://localhost'),path=url.pathname;
  const token=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization??'')?.[1]??'';
  if(!token){send(response,failure('UNAUTHORIZED','请先登录'));return;}
  const latest=url.searchParams.get('latest');const query={deviceId:url.searchParams.get('deviceId')??'',after:url.searchParams.get('after')??'0',limit:Number(url.searchParams.get('limit')??NOTIFICATION_LIMITS.page),...(latest==='true'?{latest:true}:latest==='false'?{latest:false}:{})};
  if(request.method==='GET'&&path===NOTIFICATION_ROUTES.feed){send(response,await service.feed(token,query));return;}
  if(request.method==='POST'&&path===NOTIFICATION_ROUTES.readAll){send(response,await service.readAll(token));return;}
  const read=/^\/api\/crm\/notifications\/([^/]+)\/read$/.exec(path);
  if(request.method==='POST'&&read){send(response,await service.read(token,read[1]!));return;}
  if(request.method!=='GET'||path!==NOTIFICATION_ROUTES.events){send(response,failure('NOT_FOUND','通知接口不存在'));return;}
  if(streams>=NOTIFICATION_LIMITS.stream_max){send(response,failure('RATE_LIMITED','通知连接已达上限'));return;}
  // Validate device/cursor and current authorization before switching HTTP into an event stream.
  const initial=await service.feed(token,{...query,limit:1});if(!initial.ok){send(response,initial);return;}
  if(streams>=NOTIFICATION_LIMITS.stream_max){send(response,failure('RATE_LIMITED','通知连接已达上限'));return;}
  response.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Connection':'keep-alive'});
  request.socket.setTimeout(0);streams++;let closed=false,timer:ReturnType<typeof setTimeout>|undefined,cursor=query.after;
  const close=()=>{if(closed)return;closed=true;streams--;if(timer)clearTimeout(timer);response.end();};response.once('close',close);response.once('error',close);
  const tick=async()=>{
   if(closed)return;
   try{
    const watermark=await service.watermark(token);if(closed)return;if(!watermark.ok){close();return;}
    if(response.writableLength>NOTIFICATION_LIMITS.buffer_bytes){close();return;}
    const frame=watermark.data!==cursor?`event: change\ndata: ${JSON.stringify({cursor:watermark.data})}\n\n`:': heartbeat\n\n';cursor=watermark.data;
    if(!response.write(frame)){close();return;}
   }catch{close();return;} // Fail closed: no raw adapter error or submitted token reaches a stream.
   if(!closed){timer=setTimeout(()=>{void tick();},NOTIFICATION_LIMITS.stream_poll_ms);timer.unref();}
  };
  await tick();
 };
}
