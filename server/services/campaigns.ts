import { failure, type Result } from '../core/crm';
import { CAMPAIGN_LIMITS, CAMPAIGN_STATES, type CampaignRepository, type CampaignCreate, type CampaignCommand, type CampaignPause, type CampaignClaim } from '../core/campaigns';
import type { TokenPort } from '../core/auth';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TOKEN=/^[A-Za-z0-9_-]{43}$/;
function record(v:unknown):v is Record<string,unknown>{return !!v&&typeof v==='object'&&!Array.isArray(v);}
function text(v:unknown,max:number,min=1):v is string{return typeof v==='string'&&v.trim().length>=min&&v.length<=max&&!v.includes('\0');}
function positive(v:unknown){return Number.isSafeInteger(v)&&Number(v)>0;}
function run<T>(token:string,tokens:TokenPort,fn:(hash:string)=>Promise<Result<T>>){return TOKEN.test(token)?fn(tokens.hash(token)):Promise.resolve(failure('UNAUTHORIZED','会话无效'));}
function command(v:unknown):v is CampaignCommand{return record(v)&&UUID.test(String(v.campaignId))&&positive(v.expectedVersion)&&text(v.idempotencyKey,CAMPAIGN_LIMITS.key);}
export function createCampaignService(repository:CampaignRepository,tokens?:TokenPort){
 const tokenPort=tokens??({hash:(v:string)=>v} as TokenPort);
 return {
  create(token:string,v:unknown){if(!record(v)||!text(v.name,CAMPAIGN_LIMITS.name)||!text(v.idempotencyKey,CAMPAIGN_LIMITS.key)||v.autoSend!==undefined&&typeof v.autoSend!=='boolean'||v.nextRunAt!==undefined&&(typeof v.nextRunAt!=='string'||!Number.isFinite(Date.parse(v.nextRunAt))))return Promise.resolve(failure('INVALID_INPUT','中心任务参数无效'));const value=v as {name:string;idempotencyKey:string;nextRunAt?:string};return run(token,tokenPort,h=>repository.create(h,{name:value.name.trim(),idempotencyKey:value.idempotencyKey,autoSend:false,nextRunAt:value.nextRunAt}));},
  detail(token:string,id:string){return UUID.test(id)?run(token,tokenPort,h=>repository.detail(h,id)):Promise.resolve(failure('NOT_FOUND','任务不存在'));},
  list(token:string,v:unknown){if(!record(v)||!positive(v.limit)||Number(v.limit)>CAMPAIGN_LIMITS.pageMax||!Number.isSafeInteger(v.offset)||Number(v.offset)<0||v.state!==undefined&&!CAMPAIGN_STATES.includes(v.state as never))return Promise.resolve(failure('INVALID_INPUT','中心任务列表参数无效'));return run(token,tokenPort,h=>repository.list(h,{limit:Number(v.limit),offset:Number(v.offset),...(v.state?{state:v.state as never}:{})}));},
  confirm(token:string,v:unknown){if(!command(v))return Promise.resolve(failure('INVALID_INPUT','任务确认参数无效'));return run(token,tokenPort,h=>repository.confirm(h,v));},
  pause(token:string,v:unknown){if(!command(v)||!record(v)||v.reason!==undefined&&!text(v.reason,CAMPAIGN_LIMITS.reason,0))return Promise.resolve(failure('INVALID_INPUT','任务暂停参数无效'));return run(token,tokenPort,h=>repository.pause(h,v as CampaignPause));},
  addTargets(token:string,v:unknown){if(!record(v)||!UUID.test(String(v.campaignId))||!positive(v.expectedVersion)||!text(v.idempotencyKey,CAMPAIGN_LIMITS.key)||!Array.isArray(v.targets)||v.targets.length<1||v.targets.length>CAMPAIGN_LIMITS.claimBatchMax||!v.targets.every(t=>record(t)&&Number.isSafeInteger(t.contactId)&&Number(t.contactId)>0&&UUID.test(String(t.customerId))&&positive(t.contactVersion)&&Number.isSafeInteger(t.round)&&Number(t.round)>=0&&typeof t.nextTouchAt==='string'&&Number.isFinite(Date.parse(t.nextTouchAt))))return Promise.resolve(failure('INVALID_INPUT','任务触点参数无效'));return run(token,tokenPort,h=>repository.addTargets(h,v as never));},
  claimDryRun(token:string,v:unknown){if(!record(v)||!positive(v.limit)||Number(v.limit)>CAMPAIGN_LIMITS.claimBatchMax||!text(v.workerId,CAMPAIGN_LIMITS.workerId))return Promise.resolve(failure('INVALID_INPUT','任务领取参数无效'));const value=v as {limit:number;workerId:string};return run(token,tokenPort,h=>repository.claimDryRun(h,{limit:Number(value.limit),workerId:value.workerId.trim()}));},
  completeDryRun(token:string,v:unknown){if(!record(v)||!UUID.test(String(v.attemptId))||!text(v.executionKey,CAMPAIGN_LIMITS.key)||!['accepted','rejected','unknown'].includes(String(v.state))||v.error!==undefined&&!text(v.error,CAMPAIGN_LIMITS.reason,0))return Promise.resolve(failure('INVALID_INPUT','任务试运行回执无效'));return run(token,tokenPort,h=>repository.completeDryRun(h,v as {attemptId:string;executionKey:string;state:'accepted'|'rejected'|'unknown';error?:string}));},
 };
}
export type CampaignService=ReturnType<typeof createCampaignService>;
