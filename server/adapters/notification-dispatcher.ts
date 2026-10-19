import type {LogSink} from '../core/crm';
import {NOTIFICATION_LIMITS,type NotificationRepository} from '../core/notifications';
export function startNotificationDispatcher(repo:NotificationRepository,log:LogSink){
 let stopped=false,timer:ReturnType<typeof setTimeout>|undefined,active:Promise<void>|undefined;
 const tick=()=>{if(stopped)return;active=(async()=>{try{const result=await repo.dispatch();if(!result.ok)log.write('WARN','notifications.dispatch','通知投递暂不可用');}catch{log.write('ERROR','notifications.dispatch','通知投递失败');}finally{if(!stopped){timer=setTimeout(tick,NOTIFICATION_LIMITS.poll_ms);timer.unref();}}})();};
 tick();return {async stop(){stopped=true;if(timer)clearTimeout(timer);await active;}};
}
