import type { Result } from './crm';

export const CAMPAIGN_ROUTES={campaigns:'/api/crm/campaigns',confirm:'confirm',pause:'pause',dryRunClaim:'dry-run-claim'} as const;
export const CAMPAIGN_LIMITS={name:200,key:128,reason:500,workerId:128,page:25,pageMax:100,leaseSeconds:300,claimBatch:50,claimBatchMax:100} as const;
export const CAMPAIGN_STATES=['draft','scheduled','running','paused','stopped','completed'] as const;
export type CampaignState=typeof CAMPAIGN_STATES[number];
export const CAMPAIGN_TARGET_STATES=['pending','leased','blocked','completed','unknown','revoked'] as const;
export type CampaignTargetState=typeof CAMPAIGN_TARGET_STATES[number];
export const CAMPAIGN_ATTEMPT_STATES=['planned','accepted','rejected','unknown'] as const;
export type CampaignAttemptState=typeof CAMPAIGN_ATTEMPT_STATES[number];
export interface Campaign {campaignId:string;createdBy:string;name:string;state:CampaignState;version:number;autoSend:boolean;confirmedAt:string|null;pausedAt:string|null;stoppedAt:string|null;stopReason:string|null;nextRunAt:string|null;createdAt:string;updatedAt:string;}
export interface CampaignTarget {targetId:string;campaignId:string;contactId:number;customerId:string;contactVersion:number;round:number;state:CampaignTargetState;nextTouchAt:string|null;leaseOwner:string|null;leaseUntil:string|null;attemptCount:number;lastError:string|null;}
export interface CampaignAttempt {attemptId:string;targetId:string;executionKey:string;state:CampaignAttemptState;requestedAt:string;completedAt:string|null;error:string|null;}
export interface CampaignCreate {name:string;idempotencyKey:string;autoSend?:boolean;nextRunAt?:string;}
export interface CampaignCommand {campaignId:string;expectedVersion:number;idempotencyKey:string;}
export interface CampaignPause extends CampaignCommand {reason?:string;}
export interface CampaignQuery {limit:number;offset:number;state?:CampaignState;}
export interface CampaignPage {items:Campaign[];total:number;}
export interface CampaignClaim {limit:number;workerId:string;}
export interface CampaignClaimedTarget extends CampaignTarget {attemptId:string;executionKey:string;dryRun:true;}
export interface CampaignTargetCreate {contactId:number;customerId:string;contactVersion:number;round:number;nextTouchAt:string;}
export interface CampaignRepository {
 create(hash:string,input:CampaignCreate):Promise<Result<Campaign>>;
 detail(hash:string,id:string):Promise<Result<Campaign>>;
 list(hash:string,input:CampaignQuery):Promise<Result<CampaignPage>>;
 confirm(hash:string,input:CampaignCommand):Promise<Result<Campaign>>;
 pause(hash:string,input:CampaignPause):Promise<Result<Campaign>>;
 addTargets(hash:string,input:{campaignId:string;expectedVersion:number;idempotencyKey:string;targets:CampaignTargetCreate[]}):Promise<Result<number>>;
 claimDryRun(hash:string,input:CampaignClaim):Promise<Result<CampaignClaimedTarget[]>>;
 completeDryRun(hash:string,input:{attemptId:string;executionKey:string;state:'accepted'|'rejected'|'unknown';error?:string}):Promise<Result<void>>;
}
