import type { Result } from './crm';
export const TASK_ROUTES={tasks:'/api/crm/tasks',rescheduleAction:'reschedule',completeAction:'complete'} as const;
export const TASK_LIMITS={title:500,feedback:20000,key:128,page:25,pageMax:100,dueBatch:50,dueBatchMax:100,poll_seconds:5} as const;
export const TASK_DUE_EVENT='crm.task.due' as const;
export type TaskStatus='open'|'completed';
export interface TaskCreate {opportunityId?:string;customerId:string;title:string;dueAt:string;expectedCustomerVersion:number;idempotencyKey:string;}
export interface TaskCommand {taskId:string;expectedVersion:number;idempotencyKey:string;}
export interface TaskReschedule extends TaskCommand {dueAt:string;}
export interface TaskComplete extends TaskCommand {feedback:string;}
export interface TaskQuery {customerId?:string;status?:TaskStatus;limit:number;offset:number;}
export interface FollowupTask {opportunityId?:string|null;opportunityTitle?:string|null;taskId:string;customerId:string;title:string;dueAt:string;status:TaskStatus;version:number;responsibleUserId:string;responsibleName:string|null;createdBy:string;createdAt:string;updatedAt:string;completedAt:string|null;completedBy:string|null;feedback:string|null;canManage:boolean;}
export interface TaskPage {items:FollowupTask[];total:number;}
export interface TaskRepository {
 create(hash:string,input:TaskCreate):Promise<Result<FollowupTask>>;
 list(hash:string,input:TaskQuery):Promise<Result<TaskPage>>;
 detail(hash:string,id:string):Promise<Result<FollowupTask>>;
 reschedule(hash:string,input:TaskReschedule):Promise<Result<FollowupTask>>;
 complete(hash:string,input:TaskComplete):Promise<Result<FollowupTask>>;
 processDue(limit:number):Promise<Result<number>>;
}
const TIME_LIMITS={hours:24,minutes:60,seconds:60} as const;
/** Explicit timezone plus calendar validation prevents Date.parse normalizing invalid dates. */
export function validTaskTime(value:unknown):value is string {
 if(typeof value!=='string')return false;
 const p=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
 if(!p)return false;
 const [,year,month,day,hour,minute,second,,oh,om]=p;
 const d=new Date(`${year}-${month}-${day}T00:00:00Z`);
 return d.getUTCFullYear()===Number(year)&&d.getUTCMonth()+1===Number(month)&&d.getUTCDate()===Number(day)&&Number(hour)<TIME_LIMITS.hours&&Number(minute)<TIME_LIMITS.minutes&&Number(second)<TIME_LIMITS.seconds&&(oh===undefined||Number(oh)<TIME_LIMITS.hours&&Number(om)<TIME_LIMITS.minutes)&&Number.isFinite(Date.parse(value));
}
