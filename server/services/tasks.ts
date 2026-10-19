import { failure, type Result } from '../core/crm';
import type { TokenPort } from '../core/auth';
import { TASK_LIMITS,validTaskTime,type TaskRepository,type TaskCreate,type TaskCommand,type TaskReschedule,type TaskComplete,type TaskQuery } from '../core/tasks';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function record(v:unknown):v is Record<string,unknown>{return !!v&&typeof v==='object'&&!Array.isArray(v);}
function keys(v:Record<string,unknown>,allowed:string[]){return Object.keys(v).every(k=>allowed.includes(k));}
function text(v:unknown,max:number):v is string{return typeof v==='string'&&!!v.trim()&&v.length<=max;}
function positive(v:unknown):v is number{return Number.isSafeInteger(v)&&Number(v)>0;}
function command(v:unknown):v is TaskCommand{return record(v)&&typeof v.taskId==='string'&&UUID.test(v.taskId)&&positive(v.expectedVersion)&&text(v.idempotencyKey,TASK_LIMITS.key);}
export function createTaskService(repo:TaskRepository,tokens:TokenPort){
 function run<T>(token:string,action:(hash:string)=>Promise<Result<T>>):Promise<Result<T>>{return /^[A-Za-z0-9_-]{43}$/.test(token)?action(tokens.hash(token)):Promise.resolve(failure('UNAUTHORIZED','会话无效'));}
 return {
  create(token:string,v:unknown){if(!record(v)||!keys(v,['customerId','title','dueAt','expectedCustomerVersion','idempotencyKey','opportunityId'])||typeof v.customerId!=='string'||!UUID.test(v.customerId)||v.opportunityId!==undefined&&(typeof v.opportunityId!=='string'||!UUID.test(v.opportunityId))||!text(v.title,TASK_LIMITS.title)||!validTaskTime(v.dueAt)||!positive(v.expectedCustomerVersion)||!text(v.idempotencyKey,TASK_LIMITS.key))return Promise.resolve(failure('INVALID_INPUT','任务参数无效'));return run(token,h=>repo.create(h,v as unknown as TaskCreate));},
  list(token:string,v:TaskQuery){if(!record(v)||!keys(v,['customerId','status','limit','offset'])||v.customerId!==undefined&&(typeof v.customerId!=='string'||!UUID.test(v.customerId))||v.status!==undefined&&!['open','completed'].includes(v.status as string)||!positive(v.limit)||Number(v.limit)>TASK_LIMITS.pageMax||!Number.isSafeInteger(v.offset)||Number(v.offset)<0)return Promise.resolve(failure('INVALID_INPUT','任务列表参数无效'));return run(token,h=>repo.list(h,v));},
  detail(token:string,id:string){return UUID.test(id)?run(token,h=>repo.detail(h,id)):Promise.resolve(failure('NOT_FOUND','任务不存在'));},
  reschedule(token:string,v:unknown){if(!command(v)||!keys(v as unknown as Record<string,unknown>,['taskId','expectedVersion','idempotencyKey','dueAt'])||!validTaskTime((v as unknown as Record<string,unknown>).dueAt))return Promise.resolve(failure('INVALID_INPUT','延期参数无效'));return run(token,h=>repo.reschedule(h,v as TaskReschedule));},
  complete(token:string,v:unknown){if(!command(v)||!keys(v as unknown as Record<string,unknown>,['taskId','expectedVersion','idempotencyKey','feedback'])||!text((v as unknown as Record<string,unknown>).feedback,TASK_LIMITS.feedback))return Promise.resolve(failure('INVALID_INPUT','完成反馈无效'));return run(token,h=>repo.complete(h,v as TaskComplete));},
  processDue(limit:number=TASK_LIMITS.dueBatch){return positive(limit)&&limit<=TASK_LIMITS.dueBatchMax?repo.processDue(limit):Promise.resolve(failure('INVALID_INPUT','到期扫描批次无效'));},
 };
}
export type TaskService=ReturnType<typeof createTaskService>;
