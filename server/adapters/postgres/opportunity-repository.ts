import { createHash } from 'node:crypto';
import type { Pool,PoolClient } from 'pg';
import { failure,success,type LogSink,type Result } from '../../core/crm';
import { OPPORTUNITY_EVENTS,OPPORTUNITY_LIMITS,OPPORTUNITY_STAGES,type Opportunity,type OpportunityCreate,type OpportunityHistory,type OpportunityPage,type OpportunityQuery,type OpportunityRepository,type OpportunityUpdateStage } from '../../core/opportunities';
import { authorizeLeadActor,type LeadActor } from './lead-repository';
import { ADMIN_LOCK } from './admin-schema';
import { assertCenterDatabasePool } from './config';
import { OPPORTUNITY_LOCK,OPPORTUNITY_SQL,OPPORTUNITY_VERSION } from './opportunity-schema';
type Customer={customer_id:string;created_by:string;owner_user_id:string|null;origin:string;state:string;version:number};
function administrator(a:LeadActor){return a.roles.includes('admin')&&['shared','summary'].includes(a.scope)&&a.capabilities.includes('leads.read.all');}
function operations(a:LeadActor){return a.roles.includes('operations')&&['shared','summary'].includes(a.scope)&&a.capabilities.includes('followups.read');}
function canSee(a:LeadActor,c:Customer){return administrator(a)||operations(a)&&c.origin==='operations'||c.owner_user_id===a.userId&&a.capabilities.includes('leads.develop');}
function canManage(a:LeadActor,c:Customer){return a.capabilities.includes('leads.develop')&&(administrator(a)||operations(a)&&c.origin==='operations'&&c.owner_user_id===null||c.owner_user_id===a.userId&&canSee(a,c));}
const MONEY_TYPE=`numeric(${OPPORTUNITY_LIMITS.amountWholeDigits+OPPORTUNITY_LIMITS.amountFractionDigits},${OPPORTUNITY_LIMITS.amountFractionDigits})`;
const COLUMNS=`o.opportunity_id AS "opportunityId",o.customer_id AS "customerId",o.title,o.description,o.pol,o.pod,o.container_type AS "containerType",o.source,o.stage,o.amount::${MONEY_TYPE}::text AS amount,o.currency,o.lost_reason AS "lostReason",o.evidence,o.version,o.created_by AS "createdBy",o.created_at AS "createdAt",o.updated_at AS "updatedAt",o.closed_at AS "closedAt",o.closed_by AS "closedBy",COALESCE(c.owner_user_id,c.created_by) AS "ownerUserId",u.display_name AS "ownerName"`;
function dates<T>(row:Record<string,unknown>):T{return Object.fromEntries(Object.entries(row).map(([k,v])=>[k,v instanceof Date?v.toISOString():v])) as T;}
function sameAmount(a:string|null,b:string|undefined){if(b===undefined)return true;if(a===null)return false;const normalize=(v:string)=>{const [whole,fraction='']=v.split('.');return `${whole}.${fraction.padEnd(OPPORTUNITY_LIMITS.amountFractionDigits,'0')}`;};return normalize(a)===normalize(b);}
/** CRM customer permissions and all mutations share the identity admin lock. */
export class PostgresOpportunityRepository implements OpportunityRepository {
 constructor(private readonly pool:Pool,private readonly log:LogSink){assertCenterDatabasePool(pool);}
 private async tx<T>(fn:(db:PoolClient)=>Promise<Result<T>>):Promise<Result<T>>{
  let db:PoolClient|undefined;
  try{db=await this.pool.connect();await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock($1)',[ADMIN_LOCK]);await db.query('SELECT pg_advisory_xact_lock($1)',[OPPORTUNITY_LOCK]);const result=await fn(db);await db.query(result.ok?'COMMIT':'ROLLBACK');return result;}
  catch(error){if(db)try{await db.query('ROLLBACK');}catch(rollbackError){this.log.write('ERROR','opportunities.rollback',`商机回滚失败 ${rollbackError instanceof Error?rollbackError.stack??rollbackError.message:'UNKNOWN'}`);}this.log.write('ERROR','opportunities.pg',`商机数据库操作失败 ${error instanceof Error?error.stack??error.message:'UNKNOWN'}`);return failure('DATABASE_ERROR','商机服务暂不可用');}
  finally{db?.release();}
 }
 private authorized<T>(hash:string,fn:(db:PoolClient,a:LeadActor)=>Promise<Result<T>>){return this.tx(async db=>{const a=await authorizeLeadActor(db,hash);return a?fn(db,a):failure('UNAUTHORIZED','CRM会话或产品准入已失效');});}
 private async customer(db:PoolClient,id:string){const r=await db.query('SELECT customer_id,created_by,owner_user_id,origin,state,version FROM crm_customers WHERE customer_id=$1 FOR SHARE',[id]);return r.rows[0] as Customer|undefined;}
 private async history(db:PoolClient,id:string){const r=await db.query(`SELECT h.history_id AS "historyId",h.from_stage AS "fromStage",h.to_stage AS "toStage",h.actor_id AS "actorId",u.display_name AS "actorName",h.occurred_at AS "occurredAt",h.amount::${MONEY_TYPE}::text AS amount,h.currency,h.lost_reason AS "lostReason",h.evidence FROM crm_opportunity_stage_history h LEFT JOIN identity.users u ON u.user_id=h.actor_id WHERE h.opportunity_id=$1 ORDER BY h.occurred_at,h.history_id`,[id]);return r.rows.map(x=>dates<OpportunityHistory>(x));}
 private async one(db:PoolClient,id:string,a:LeadActor,lock=false):Promise<Result<Opportunity>>{
  const r=await db.query(`SELECT ${COLUMNS} FROM crm_opportunities o JOIN crm_customers c USING(customer_id) JOIN identity.users u ON u.user_id=COALESCE(c.owner_user_id,c.created_by) WHERE o.opportunity_id=$1 ${lock?'FOR UPDATE OF o':''}`,[id]);if(!r.rows.length)return failure('NOT_FOUND','商机不存在');const customer=await this.customer(db,r.rows[0].customerId);if(!customer||!canSee(a,customer))return failure('NOT_FOUND','商机不存在');return success({...dates<Opportunity>(r.rows[0]),canManage:canManage(a,customer),history:await this.history(db,id)});
 }
 private async cached(db:PoolClient,a:LeadActor,operation:string,input:{idempotencyKey:string},fn:()=>Promise<Result<Opportunity>>):Promise<Result<Opportunity>>{
  const digest=createHash('sha256').update(JSON.stringify(input)).digest('hex'),old=await db.query('SELECT digest,response FROM crm_lead_idempotency WHERE actor_id=$1 AND operation=$2 AND key=$3',[a.userId,operation,input.idempotencyKey]);
  if(old.rows.length){if(old.rows[0].digest!==digest)return failure('CONFLICT','幂等键已用于不同请求');const current=await this.one(db,old.rows[0].response.opportunityId,a);if(!current.ok)return current;if(!current.data.canManage)return failure('FORBIDDEN','只能处理自身商机');return current;}
  const result=await fn();if(result.ok)await db.query('INSERT INTO crm_lead_idempotency(actor_id,operation,key,digest,response) VALUES($1,$2,$3,$4,$5)',[a.userId,operation,input.idempotencyKey,digest,JSON.stringify({opportunityId:result.data.opportunityId})]);return result;
 }
 private async record(db:PoolClient,a:LeadActor,o:Opportunity,from:string|null){await db.query('INSERT INTO crm_opportunity_stage_history(opportunity_id,from_stage,to_stage,actor_id,amount,currency,lost_reason,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[o.opportunityId,from,o.stage,a.userId,o.amount,o.currency,o.lostReason,o.evidence]);const c=await this.customer(db,o.customerId);await db.query('INSERT INTO identity.outbox(event_type,user_id,product_id,revision,customer_id,payload) VALUES($1,$2,$3,$4,$5,$6)',[from===null?OPPORTUNITY_EVENTS.created:OPPORTUNITY_EVENTS.stageChanged,a.userId,'crm',c!.version,o.customerId,JSON.stringify({customerId:o.customerId,version:c!.version,opportunityId:o.opportunityId,opportunityVersion:o.version})]);}
 migrate(){return this.tx(async db=>{const hash=createHash('sha256').update(OPPORTUNITY_SQL).digest('hex'),old=await db.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1',[OPPORTUNITY_VERSION]);if(old.rows.length&&old.rows[0].checksum!==hash)return failure('CONFLICT','商机迁移校验不一致');if(!old.rows.length){await db.query(OPPORTUNITY_SQL);await db.query('INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)',[OPPORTUNITY_VERSION,hash]);this.log.write('INFO','opportunities.migrate',`迁移完成 version=${OPPORTUNITY_VERSION}`);}return success(undefined);});}
 create(hash:string,input:OpportunityCreate){return this.authorized(hash,async(db,a)=>{
  const c=await this.customer(db,input.customerId);if(!c||!canSee(a,c))return failure('NOT_FOUND','客户不存在');if(!canManage(a,c))return failure('FORBIDDEN','只能处理自身商机');
  return this.cached(db,a,`opportunity:create:${input.customerId}`,input,async()=>{if(c.version!==input.expectedCustomerVersion)return failure('CONFLICT','客户版本已变化');const r=await db.query('INSERT INTO crm_opportunities(customer_id,title,description,pol,pod,container_type,source,amount,currency,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING opportunity_id',[input.customerId,input.title.trim(),input.description?.trim()??'',input.pol?.trim()||null,input.pod?.trim()||null,input.containerType?.trim()||null,input.source?.trim()??'',input.amount??null,input.currency??null,a.userId]);const created=await this.one(db,r.rows[0].opportunity_id,a);if(!created.ok)return created;await this.record(db,a,created.data,null);return this.one(db,created.data.opportunityId,a);});
 });}
 list(hash:string,input:OpportunityQuery):Promise<Result<OpportunityPage>>{return this.authorized(hash,async(db,a)=>{const c=await this.customer(db,input.customerId);if(!c||!canSee(a,c))return failure('NOT_FOUND','客户不存在');const count=await db.query('SELECT count(*)::int AS n FROM crm_opportunities WHERE customer_id=$1',[input.customerId]),rows=await db.query(`SELECT ${COLUMNS} FROM crm_opportunities o JOIN crm_customers c USING(customer_id) JOIN identity.users u ON u.user_id=COALESCE(c.owner_user_id,c.created_by) WHERE o.customer_id=$1 ORDER BY o.created_at DESC,o.opportunity_id LIMIT $2 OFFSET $3`,[input.customerId,input.limit,input.offset]);const items:Opportunity[]=[];for(const row of rows.rows)items.push({...dates<Opportunity>(row),canManage:canManage(a,c),history:await this.history(db,row.opportunityId)});return success({items,total:count.rows[0].n});});}
 detail(hash:string,id:string){return this.authorized(hash,(db,a)=>this.one(db,id,a));}
 updateStage(hash:string,input:OpportunityUpdateStage){return this.authorized(hash,async(db,a)=>{
  const existing=await this.one(db,input.opportunityId,a,true);if(!existing.ok)return existing;if(!existing.data.canManage)return failure('FORBIDDEN','只能处理自身商机');
  return this.cached(db,a,`opportunity:stage:${input.opportunityId}`,input,async()=>{
   const o=existing.data;if(o.version!==input.expectedVersion)return failure('CONFLICT','商机版本已变化');
   if(o.stage===input.stage){if(!sameAmount(o.amount,input.amount)||input.currency!==undefined&&o.currency!==input.currency||input.evidence!==undefined&&o.evidence!==input.evidence.trim()||input.lostReason!==undefined&&o.lostReason!==input.lostReason.trim())return failure('INVALID_INPUT','同阶段不能修改成交信息');return success(o);}
   if(['closed_won','closed_lost'].includes(o.stage)||OPPORTUNITY_STAGES.indexOf(input.stage)<OPPORTUNITY_STAGES.indexOf(o.stage))return failure('CONFLICT','商机阶段不能回退或重开');
   const amount=input.amount??o.amount,currency=input.currency??o.currency,evidence=input.stage==='closed_won'?input.evidence?.trim()??null:null,lostReason=input.stage==='closed_lost'?input.lostReason?.trim()??null:null;
   if(input.stage==='closed_won'&&(!amount||!currency||!evidence)||input.stage==='closed_lost'&&!lostReason)return failure('INVALID_INPUT','成交需金额、币种和证据；丢单需原因');
   await db.query(`UPDATE crm_opportunities SET stage=$2,amount=$3,currency=$4,evidence=$5,lost_reason=$6,version=version+1,updated_at=clock_timestamp(),closed_at=CASE WHEN $2 IN ('closed_won','closed_lost') THEN clock_timestamp() ELSE NULL END,closed_by=CASE WHEN $2 IN ('closed_won','closed_lost') THEN $7::uuid ELSE NULL END WHERE opportunity_id=$1 AND version=$8`,[input.opportunityId,input.stage,amount,currency,evidence,lostReason,a.userId,input.expectedVersion]);
   const changed=await this.one(db,input.opportunityId,a);if(!changed.ok)return changed;await this.record(db,a,changed.data,o.stage);return this.one(db,input.opportunityId,a);
  });
 });}
}
