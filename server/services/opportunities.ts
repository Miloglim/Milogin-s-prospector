import { failure,type Result } from '../core/crm';
import type { TokenPort } from '../core/auth';
import { OPPORTUNITY_LIMITS,OPPORTUNITY_STAGES,type OpportunityRepository,type OpportunityCreate,type OpportunityUpdateStage,type OpportunityQuery } from '../core/opportunities';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const AMOUNT=new RegExp(`^(0|[1-9][0-9]{0,${OPPORTUNITY_LIMITS.amountWholeDigits-1}})(\\.[0-9]{1,${OPPORTUNITY_LIMITS.amountFractionDigits}})?$`);
function record(v:unknown):v is Record<string,unknown>{return !!v&&typeof v==='object'&&!Array.isArray(v);}
function keys(v:Record<string,unknown>,allowed:string[]){return Object.keys(v).every(k=>allowed.includes(k));}
function text(v:unknown,max:number,required=false):v is string{return typeof v==='string'&&v.length<=max&&(!required||!!v.trim());}
function positive(v:unknown){return Number.isSafeInteger(v)&&Number(v)>0;}
function amount(v:Record<string,unknown>){return v.amount===undefined&&v.currency===undefined||typeof v.amount==='string'&&AMOUNT.test(v.amount)&&typeof v.currency==='string'&&/^[A-Z]{3}$/.test(v.currency);}
/** Input validation is pure; permissions and transitions are rechecked in the repository transaction. */
export function createOpportunityService(repo:OpportunityRepository,tokens:TokenPort){
 function run<T>(token:string,action:(hash:string)=>Promise<Result<T>>):Promise<Result<T>>{return /^[A-Za-z0-9_-]{43}$/.test(token)?action(tokens.hash(token)):Promise.resolve(failure('UNAUTHORIZED','会话无效'));}
 return {
  create(token:string,v:unknown){
   if(!record(v)||!keys(v,['customerId','expectedCustomerVersion','idempotencyKey','title','description','pol','pod','containerType','source','amount','currency'])||typeof v.customerId!=='string'||!UUID.test(v.customerId)||!positive(v.expectedCustomerVersion)||!text(v.idempotencyKey,OPPORTUNITY_LIMITS.key,true)||!text(v.title,OPPORTUNITY_LIMITS.title,true)||!amount(v)||v.description!==undefined&&!text(v.description,OPPORTUNITY_LIMITS.description)||['pol','pod','containerType'].some(k=>v[k]!==undefined&&!text(v[k],OPPORTUNITY_LIMITS.route))||v.source!==undefined&&!text(v.source,OPPORTUNITY_LIMITS.source))return Promise.resolve(failure('INVALID_INPUT','商机参数无效'));
   return run(token,h=>repo.create(h,v as unknown as OpportunityCreate));
  },
  list(token:string,v:OpportunityQuery){if(!record(v)||!keys(v,['customerId','limit','offset'])||typeof v.customerId!=='string'||!UUID.test(v.customerId)||!positive(v.limit)||v.limit>OPPORTUNITY_LIMITS.pageMax||!Number.isSafeInteger(v.offset)||v.offset<0)return Promise.resolve(failure('INVALID_INPUT','商机列表参数无效'));return run(token,h=>repo.list(h,v));},
  detail(token:string,id:string){return typeof id==='string'&&UUID.test(id)?run(token,h=>repo.detail(h,id)):Promise.resolve(failure('NOT_FOUND','商机不存在'));},
  updateStage(token:string,v:unknown){
   if(!record(v)||!keys(v,['opportunityId','expectedVersion','idempotencyKey','stage','amount','currency','evidence','lostReason'])||typeof v.opportunityId!=='string'||!UUID.test(v.opportunityId)||!positive(v.expectedVersion)||!text(v.idempotencyKey,OPPORTUNITY_LIMITS.key,true)||!OPPORTUNITY_STAGES.includes(v.stage as never)||!amount(v)||v.evidence!==undefined&&!text(v.evidence,OPPORTUNITY_LIMITS.evidence,true)||v.lostReason!==undefined&&!text(v.lostReason,OPPORTUNITY_LIMITS.reason,true)||v.stage==='closed_won'&&!text(v.evidence,OPPORTUNITY_LIMITS.evidence,true)||v.stage==='closed_lost'&&!text(v.lostReason,OPPORTUNITY_LIMITS.reason,true)||v.evidence!==undefined&&v.stage!=='closed_won'||v.lostReason!==undefined&&v.stage!=='closed_lost')return Promise.resolve(failure('INVALID_INPUT','商机阶段参数无效'));
   return run(token,h=>repo.updateStage(h,v as unknown as OpportunityUpdateStage));
  },
 };
}
export type OpportunityService=ReturnType<typeof createOpportunityService>;
