import { TASK_LIMITS } from '../core/tasks';
import type { LogSink } from '../core/crm';
import type { TaskService } from '../services/tasks';
const MILLISECONDS_PER_SECOND=1000;
/** Center-owned scheduler; bounded, serial scans resume durable due work after restarts. */
export function startTaskDispatcher(service:TaskService,log:LogSink) {
  let stopped=false,timer:ReturnType<typeof setTimeout>|undefined,active:Promise<void>|undefined;
  const tick=()=>{
    if(stopped)return;
    active=(async()=>{
      try { const result=await service.processDue();if(!result.ok)log.write('WARN','tasks.dispatch','跟进提醒扫描暂不可用'); }
      catch (error) {log.write('ERROR','tasks.dispatch',`跟进提醒扫描失败 ${error instanceof Error ? error.stack ?? error.message : String(error)}`);}
      finally {if(!stopped){timer=setTimeout(tick,TASK_LIMITS.poll_seconds*MILLISECONDS_PER_SECOND);timer.unref();}}
    })();
  };
  tick();return {async stop(){stopped=true;if(timer)clearTimeout(timer);await active;}};
}
