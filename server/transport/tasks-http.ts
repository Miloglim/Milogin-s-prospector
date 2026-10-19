import { failure } from '../core/crm';
import { TASK_ROUTES, TASK_LIMITS, type TaskStatus } from '../core/tasks';
import { LEAD_LIMITS } from '../core/leads';
import type { TaskService } from '../services/tasks';
import { body, send, type BrowserHandler } from './http';

export function createTaskHandler(service:TaskService):BrowserHandler { return async(request,response)=>{
  const url=new URL(request.url??'/','http://localhost');
  const token=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization??'')?.[1]??'';
  if(request.method==='GET' && url.pathname===TASK_ROUTES.tasks){send(response,await service.list(token,{limit:Number(url.searchParams.get('limit')??TASK_LIMITS.page),offset:Number(url.searchParams.get('offset')??0),...(url.searchParams.has('customerId')?{customerId:url.searchParams.get('customerId')!}:{}),...(url.searchParams.has('status')?{status:url.searchParams.get('status') as TaskStatus}:{})}));return;}
  const parts=url.pathname.slice(TASK_ROUTES.tasks.length+1).split('/');
  if(request.method==='GET' && url.pathname.startsWith(`${TASK_ROUTES.tasks}/`) && parts.length===1){send(response,await service.detail(token,parts[0]!));return;}
  if(request.method==='POST') {
    const input=await body(request,LEAD_LIMITS.bodyBytes);if(!input.ok){send(response,input);return;}
    if(url.pathname===TASK_ROUTES.tasks){send(response,await service.create(token,input.data));return;}
    if(url.pathname.startsWith(`${TASK_ROUTES.tasks}/`) && parts.length===2 && (parts[1]===TASK_ROUTES.rescheduleAction || parts[1]===TASK_ROUTES.completeAction)){
      if(!input.data||typeof input.data!=='object'||Array.isArray(input.data)||'taskId'in input.data&&input.data.taskId!==parts[0]){send(response,failure('INVALID_INPUT','路径与任务编号不一致'));return;}
      const command={...input.data,taskId:parts[0]};
      send(response,parts[1]===TASK_ROUTES.completeAction?await service.complete(token,command):await service.reschedule(token,command));return;
    }
  }
  send(response,failure('NOT_FOUND','任务接口不存在'));
};}
