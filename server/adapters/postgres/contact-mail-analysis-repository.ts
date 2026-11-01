import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { failure, success, type LogSink, type Result } from '../../core/crm';
import type {
  ContactMailAnalysisCorrection,
  ContactMailAnalysisQuery,
  ContactMailAnalysisRecord,
  ContactMailAnalysisRepository,
  ContactMailAnalysisSubmission,
  ContactMailAnalysisView,
  MailAnalysisResult,
  MailAnalysisSource,
  MailBusinessSignal,
  MailContactState,
  MailPriority,
  MailRelevance,
} from '../../core/mail-analysis';
import { contactStateForMail, mailThreadKey, mechanicalMailAnalysis, newerAnalysisWins, taskSuggestionFor } from '../../core/mail-analysis';
import type { ContactMailEventInput } from '../../core/contact-mail';
import { canReadContact, contactMonitorDetailIn, loadContactIn } from './contact-assignment-repository';
import { authorizeLeadActor, type LeadActor } from './lead-repository';
import { ensureContactMailAnalysisSchemaIn } from './contact-mail-analysis-schema';
import { ensureTeamAttentionSchemaIn } from './team-attention-schema';
import { createMailAnalysisTaskIn } from './task-repository';

const SUMMARY_MAX = 2000;
const DIGEST_FIELDS = ['contactId','customerId','mailboxKey','messageKey','contentHash','source','inputSequence','result','classification','relevance','summary','signals','requiresAction','nextAction','priority','dueHint','confidence','evidence'] as const;

interface AnalysisRow {
  analysisId:string; actorId:string; eventId:string|null; contactId:number; customerId:string;
  mailboxKey:string; messageKey:string; contentHash:string; threadKey:string; analyzerVersion:string;
  inputSequence:string|number; source:MailAnalysisSource; relevance:MailRelevance; classification:ContactMailAnalysisRecord['classification'];
  contactState:MailContactState|null; summary:string; signals:MailBusinessSignal[]|string; requiresAction:boolean;
  nextAction:string|null; priority:MailPriority; dueHint:string|null; confidence:string|number; evidence:string[]|string;
  humanLocked:boolean; supersedesId:string|null; isCurrent:boolean; createdAt:Date|string;
}

interface InsertAnalysisInput {
  actorId:string; eventId:string|null; contactId:number; customerId:string; mailboxKey:string; messageKey:string;
  contentHash:string; threadKey:string; analyzerVersion:string; inputSequence:number; source:MailAnalysisSource;
  relevance:MailRelevance; classification:ContactMailAnalysisRecord['classification']; contactState:MailContactState|null;
  summary:string; signals:MailBusinessSignal[]; requiresAction:boolean; nextAction:string|null; priority:MailPriority;
  dueHint:string|null; confidence:number; evidence:string[]; idempotencyKey:string;
}

function sha(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function jsonArray<T>(value: T[] | string): T[] {
  if (Array.isArray(value)) return value;
  try { const parsed=JSON.parse(value); return Array.isArray(parsed)?parsed as T[]:[]; }
  catch { return []; } // Database JSON is constrained to arrays; malformed legacy text is treated as no evidence.
}

function mapped(row: AnalysisRow): ContactMailAnalysisRecord {
  return {
    analysisId:String(row.analysisId), actorId:String(row.actorId), eventId:row.eventId?String(row.eventId):null,
    contactId:Number(row.contactId), customerId:String(row.customerId), mailboxKey:String(row.mailboxKey),
    messageKey:String(row.messageKey), contentHash:String(row.contentHash), threadKey:String(row.threadKey),
    analyzerVersion:String(row.analyzerVersion), inputSequence:Number(row.inputSequence), source:row.source,
    relevance:row.relevance, classification:row.classification, contactState:row.contactState,
    summary:String(row.summary), signals:jsonArray<MailBusinessSignal>(row.signals), requiresAction:row.requiresAction,
    nextAction:row.nextAction, priority:row.priority, dueHint:row.dueHint, confidence:Number(row.confidence),
    evidence:jsonArray<string>(row.evidence), humanLocked:row.humanLocked, supersedesId:row.supersedesId?String(row.supersedesId):null,
    isCurrent:row.isCurrent, createdAt:new Date(row.createdAt).toISOString(),
  };
}

const RECORD_COLUMNS = `analysis_id AS "analysisId",actor_id AS "actorId",event_id AS "eventId",contact_id AS "contactId",customer_id AS "customerId",mailbox_key AS "mailboxKey",message_key AS "messageKey",content_hash AS "contentHash",thread_key AS "threadKey",analyzer_version AS "analyzerVersion",input_sequence AS "inputSequence",source,relevance,classification,contact_state AS "contactState",summary,signals,requires_action AS "requiresAction",next_action AS "nextAction",priority,due_hint AS "dueHint",confidence,evidence,human_locked AS "humanLocked",supersedes_id AS "supersedesId",is_current AS "isCurrent",created_at AS "createdAt"`;

function digestFor(value: unknown): string {
  const source=value&&typeof value==='object'?value as Record<string,unknown>:{};
  const fields=Object.fromEntries(DIGEST_FIELDS.filter(key=>Object.hasOwn(source,key)).map(key=>[key,source[key]]));
  if(source.source==='rule')delete fields.inputSequence;
  return sha(fields);
}

function streamLockKey(input: {actorId:string;contactId:number;mailboxKey:string;messageKey:string;contentHash:string}): string {
  return [input.actorId,input.contactId,input.mailboxKey,input.messageKey,input.contentHash].join('|');
}

async function existingReceipt(c:PoolClient,input:InsertAnalysisInput,digest:string):Promise<Result<ContactMailAnalysisRecord>|null>{
  const old=await c.query(`SELECT ${RECORD_COLUMNS},request_digest FROM crm_contact_mail_analyses WHERE actor_id=$1 AND mailbox_key=$2 AND message_key=$3 AND contact_id=$4 AND content_hash=$5 AND idempotency_key=$6`,[input.actorId,input.mailboxKey,input.messageKey,input.contactId,input.contentHash,input.idempotencyKey]);
  if(!old.rows.length)return null;
  if(old.rows[0].request_digest!==digest)return failure('CONFLICT','分析幂等键已用于不同结论');
  return success(mapped(old.rows[0] as AnalysisRow));
}

async function syncSuggestionIn(c:PoolClient,record:ContactMailAnalysisRecord,previousCurrentId:string|null):Promise<Result<string|null>>{
  const suggestion=taskSuggestionFor(record);
  const actionCode=record.classification==='bounced'?'fix_email':record.signals[0]?.code??'other';
  const actionable=record.relevance==='customer_business'&&record.requiresAction&&!!record.nextAction?.trim();
  if(!actionable){
    if(previousCurrentId)await c.query("UPDATE crm_contact_mail_task_suggestions SET status='dismissed',version=version+1,updated_at=clock_timestamp() WHERE source_analysis_id=$1 AND status='suggested'",[previousCurrentId]);
    return success(null);
  }
  const nextAction=suggestion?.nextAction??record.nextAction!;
  const priority=suggestion?.priority??record.priority;
  const dueHint=suggestion?.dueHint??record.dueHint;
  const inserted=await c.query(`INSERT INTO crm_contact_mail_task_suggestions(actor_id,contact_id,customer_id,thread_key,action_code,source_analysis_id,next_action,priority,due_hint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(actor_id,contact_id,thread_key,action_code) DO UPDATE SET source_analysis_id=EXCLUDED.source_analysis_id,next_action=EXCLUDED.next_action,priority=EXCLUDED.priority,due_hint=EXCLUDED.due_hint,status=CASE WHEN crm_contact_mail_task_suggestions.status='dismissed' AND $10::boolean=false THEN crm_contact_mail_task_suggestions.status ELSE 'suggested' END,version=crm_contact_mail_task_suggestions.version+1,updated_at=clock_timestamp() RETURNING suggestion_id`,[record.actorId,record.contactId,record.customerId,record.threadKey,actionCode,record.analysisId,nextAction,priority,dueHint,record.source==='human']);
  return success(inserted.rows.length?String(inserted.rows[0].suggestion_id):null);
}

async function insertAnalysisIn(c:PoolClient,input:InsertAnalysisInput):Promise<Result<ContactMailAnalysisRecord>>{
  const migrated=await ensureContactMailAnalysisSchemaIn(c);if(!migrated.ok)return migrated;
  const attentionMigrated=await ensureTeamAttentionSchemaIn(c);if(!attentionMigrated.ok)return attentionMigrated;
  const digest=digestFor(input),old=await existingReceipt(c,input,digest);if(old)return old;
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[streamLockKey(input)]);
  const duplicate=await existingReceipt(c,input,digest);if(duplicate)return duplicate;
  const current=(await c.query(`SELECT ${RECORD_COLUMNS} FROM crm_contact_mail_analyses WHERE actor_id=$1 AND mailbox_key=$2 AND message_key=$3 AND contact_id=$4 AND content_hash=$5 AND is_current FOR UPDATE`,[input.actorId,input.mailboxKey,input.messageKey,input.contactId,input.contentHash])).rows[0] as AnalysisRow|undefined;
  const makeCurrent=newerAnalysisWins(input,current?mapped(current):null);
  if(makeCurrent)await c.query('UPDATE crm_contact_mail_analyses SET is_current=false WHERE actor_id=$1 AND mailbox_key=$2 AND message_key=$3 AND contact_id=$4 AND content_hash=$5 AND is_current',[input.actorId,input.mailboxKey,input.messageKey,input.contactId,input.contentHash]);
  const inserted=(await c.query(`INSERT INTO crm_contact_mail_analyses(actor_id,event_id,contact_id,customer_id,mailbox_key,message_key,content_hash,thread_key,analyzer_version,input_sequence,source,relevance,classification,contact_state,summary,signals,requires_action,next_action,priority,due_hint,confidence,evidence,human_locked,idempotency_key,request_digest,supersedes_id,is_current) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19,$20,$21,$22::jsonb,$23,$24,$25,$26,$27) RETURNING ${RECORD_COLUMNS}`,[input.actorId,input.eventId,input.contactId,input.customerId,input.mailboxKey,input.messageKey,input.contentHash,input.threadKey,input.analyzerVersion,input.inputSequence,input.source,input.relevance,input.classification,input.contactState,input.summary.slice(0,SUMMARY_MAX),JSON.stringify(input.signals),input.requiresAction,input.nextAction,input.priority,input.dueHint,input.confidence,JSON.stringify(input.evidence),input.source==='human',input.idempotencyKey,digest,current?.analysisId??null,makeCurrent])).rows[0] as AnalysisRow;
  const record=mapped(inserted);
  if(record.isCurrent){
    const suggestion=await syncSuggestionIn(c,record,current?.analysisId?String(current.analysisId):null);if(!suggestion.ok)return suggestion;
    if(suggestion.data){
      const created=await createMailAnalysisTaskIn(c,{actorId:record.actorId,suggestionId:suggestion.data,analysisId:record.analysisId,customerId:record.customerId,contactId:record.contactId,threadKey:record.threadKey,actionCode:record.classification==='bounced'?'fix_email':record.signals[0]?.code??'other',title:record.nextAction??'处理客户邮件',priority:record.priority,relevance:record.relevance,classification:record.classification,source:record.source,confidence:record.confidence,requiresAction:record.requiresAction,nextAction:record.nextAction,signals:record.signals});
      if(!created.ok)return created;
    }
  }
  return success(record);
}

function domain(email:string):string|null{const at=email.trim().toLowerCase().lastIndexOf('@');return at>0?email.trim().toLowerCase().slice(at+1):null;}

export async function recordMechanicalMailAnalysisIn(c:PoolClient,actor:LeadActor,input:ContactMailEventInput,eventId:string,contentHash:string,primaryEmail:string|null,inputSequence=new Date(input.occurredAt).getTime()):Promise<Result<ContactMailAnalysisRecord>>{
  const senderDomain=domain(input.fromEmail),recipientDomains=input.toEmails.map(domain).filter((value):value is string=>!!value);
  const result:MailAnalysisResult=mechanicalMailAnalysis({
    kind:input.kind,direction:input.direction,subject:input.subject,preview:input.preview,fromEmail:input.fromEmail,
    toEmails:input.toEmails,ccEmails:input.ccEmails,matchedContact:true,primaryEmail,
    internal:!!senderDomain&&recipientDomains.includes(senderDomain),
  });
  return insertAnalysisIn(c,{
    actorId:actor.userId,eventId,contactId:input.contactId,customerId:input.customerId,mailboxKey:input.mailboxKey,
    messageKey:input.messageKey,contentHash,threadKey:mailThreadKey(input.subject,input.messageKey),
    analyzerVersion:result.analyzerVersion,inputSequence,source:result.source,
    relevance:result.relevance,classification:result.classification,contactState:result.contactState,summary:result.summary,
    signals:result.signals,requiresAction:result.actionability.requiresAction,nextAction:result.actionability.nextAction,
    priority:result.actionability.priority,dueHint:result.actionability.dueHint,confidence:result.confidence,
    evidence:result.evidence,idempotencyKey:`rule:${result.analyzerVersion}:${contentHash}:${input.kind}:${input.direction}`,
  });
}

export class PostgresContactMailAnalysisRepository implements ContactMailAnalysisRepository {
  constructor(private readonly pool:Pool,private readonly log:LogSink){}

  private async tx<T>(action:(c:PoolClient,a:LeadActor)=>Promise<Result<T>>,tokenHash:string):Promise<Result<T>>{
    const c=await this.pool.connect();
    try{
      await c.query('BEGIN');
      const actor=await authorizeLeadActor(c,tokenHash);
      const result=actor?await action(c,actor):failure('UNAUTHORIZED','CRM会话或产品准入已失效') as Result<T>;
      await c.query(result.ok?'COMMIT':'ROLLBACK');
      return result;
    }catch(error){
      try{await c.query('ROLLBACK');}catch{this.log.write('ERROR','contact-mail-analysis.rollback','回滚失败');}
      this.log.write('ERROR','contact-mail-analysis.pg',error instanceof Error?error.message:'操作失败');
      return failure('DATABASE_ERROR','邮件分析暂不可用');
    }finally{c.release();}
  }

  async migrate():Promise<Result<void>>{
    const c=await this.pool.connect();
    try{await c.query('BEGIN');const analysis=await ensureContactMailAnalysisSchemaIn(c);if(!analysis.ok){await c.query('ROLLBACK');return analysis;}const result=await ensureTeamAttentionSchemaIn(c);await c.query(result.ok?'COMMIT':'ROLLBACK');return result;}
    catch(error){try{await c.query('ROLLBACK');}catch{this.log.write('ERROR','contact-mail-analysis.migrate','迁移回滚失败');}this.log.write('ERROR','contact-mail-analysis.migrate',error instanceof Error?error.message:'迁移失败');return failure('DATABASE_ERROR','邮件分析迁移失败');}
    finally{c.release();}
  }

  private async scope(c:PoolClient,a:LeadActor,input:{contactId:number;customerId:string}):Promise<Result<'normal'|'monitor'>>{
    const contact=await loadContactIn(c,input);
    if(!contact)return failure('NOT_FOUND','联系人不存在');
    if(canReadContact(a,contact))return success('normal');
    const monitor=await contactMonitorDetailIn(c,a,input);
    return monitor.ok?success('monitor'):failure('FORBIDDEN','无邮件分析查看权限');
  }

  private async streamActor(c:PoolClient,input:{contactId:number;customerId:string;mailboxKey:string;messageKey:string},fallback:string):Promise<string>{
    const row=(await c.query('SELECT actor_id FROM crm_contact_mail_events WHERE contact_id=$1 AND customer_id=$2 AND mailbox_key=$3 AND message_key=$4 ORDER BY recorded_at DESC,event_id DESC LIMIT 1',[input.contactId,input.customerId,input.mailboxKey,input.messageKey])).rows[0];
    return row?.actor_id?String(row.actor_id):fallback;
  }

  current(tokenHash:string,input:ContactMailAnalysisQuery):Promise<Result<ContactMailAnalysisView>>{
    return this.tx(async(c,a)=>{
      const scope=await this.scope(c,a,input);if(!scope.ok)return scope;
      const migrated=await ensureContactMailAnalysisSchemaIn(c);if(!migrated.ok)return migrated;
      const actorId=await this.streamActor(c,input,a.userId);
      const currentRow=(await c.query(`SELECT ${RECORD_COLUMNS} FROM crm_contact_mail_analyses WHERE actor_id=$1 AND mailbox_key=$2 AND message_key=$3 AND contact_id=$4 AND content_hash=$5 AND is_current LIMIT 1`,[actorId,input.mailboxKey,input.messageKey,input.contactId,input.contentHash])).rows[0] as AnalysisRow|undefined;
      if(!currentRow)return failure('NOT_FOUND','邮件分析不存在');
      const current=mapped(currentRow);
      const history=input.includeHistory?(await c.query(`SELECT ${RECORD_COLUMNS} FROM crm_contact_mail_analyses WHERE actor_id=$1 AND mailbox_key=$2 AND message_key=$3 AND contact_id=$4 AND content_hash=$5 AND NOT is_current ORDER BY input_sequence DESC,created_at DESC,analysis_id DESC LIMIT $6`,[actorId,input.mailboxKey,input.messageKey,input.contactId,input.contentHash,input.historyLimit])).rows.map(row=>mapped(row as AnalysisRow)):[];
      const suggestion=(await c.query("SELECT suggestion_id,thread_key,action_code,next_action,priority,due_hint FROM crm_contact_mail_task_suggestions WHERE actor_id=$1 AND contact_id=$2 AND thread_key=$3 AND status='suggested' ORDER BY updated_at DESC,suggestion_id LIMIT 1",[actorId,input.contactId,current.threadKey])).rows[0];
      return success({current,history,canCorrect:scope.data==='normal',access:scope.data,taskSuggestion:suggestion?{key:[actorId,String(input.contactId),String(suggestion.thread_key),String(suggestion.action_code)].join('|'),actionCode:String(suggestion.action_code) as NonNullable<ContactMailAnalysisView['taskSuggestion']>['actionCode'],nextAction:String(suggestion.next_action),priority:String(suggestion.priority) as MailPriority,dueHint:suggestion.due_hint?String(suggestion.due_hint):null}:null});
    },tokenHash);
  }

  submitAI(tokenHash:string,input:ContactMailAnalysisSubmission):Promise<Result<ContactMailAnalysisRecord>>{
    return this.tx(async(c,a)=>{
      const scope=await this.scope(c,a,input);if(!scope.ok)return scope;if(scope.data!=='normal')return failure('FORBIDDEN','监督范围只读');
      const event=(await c.query('SELECT event_id,kind,direction,from_email,subject FROM crm_contact_mail_events WHERE actor_id=$1 AND contact_id=$2 AND customer_id=$3 AND mailbox_key=$4 AND message_key=$5 ORDER BY recorded_at DESC,event_id DESC LIMIT 1',[a.userId,input.contactId,input.customerId,input.mailboxKey,input.messageKey])).rows[0];
      if(!event)return failure('NOT_FOUND','邮件证据不存在');
      const contact=await loadContactIn(c,input),state=contactStateForMail(event.kind,event.direction,event.from_email,contact?.email??null),actionability=event.direction==='inbound'?input.result.actionability:{requiresAction:false,nextAction:null,priority:'normal' as const,dueHint:null};
      return insertAnalysisIn(c,{actorId:a.userId,eventId:String(event.event_id),contactId:input.contactId,customerId:input.customerId,mailboxKey:input.mailboxKey,messageKey:input.messageKey,contentHash:input.contentHash,threadKey:mailThreadKey(String(event.subject??input.result.summary),input.messageKey),analyzerVersion:input.result.analyzerVersion,inputSequence:input.inputSequence,source:'ai',relevance:input.result.relevance,classification:input.result.classification,contactState:state,summary:input.result.summary,signals:input.result.signals,requiresAction:actionability.requiresAction,nextAction:actionability.nextAction,priority:actionability.priority,dueHint:actionability.dueHint,confidence:input.result.confidence,evidence:input.result.evidence,idempotencyKey:input.idempotencyKey});
    },tokenHash);
  }

  correct(tokenHash:string,input:ContactMailAnalysisCorrection):Promise<Result<ContactMailAnalysisRecord>>{
    return this.tx(async(c,a)=>{
      const scope=await this.scope(c,a,input);if(!scope.ok)return scope;if(scope.data!=='normal')return failure('FORBIDDEN','监督范围只读');
      const actorId=await this.streamActor(c,input,a.userId);
      const current=(await c.query(`SELECT ${RECORD_COLUMNS} FROM crm_contact_mail_analyses WHERE actor_id=$1 AND mailbox_key=$2 AND message_key=$3 AND contact_id=$4 AND content_hash=$5 AND is_current FOR UPDATE`,[actorId,input.mailboxKey,input.messageKey,input.contactId,input.contentHash])).rows[0] as AnalysisRow|undefined;
      if(!current||String(current.analysisId)!==input.expectedCurrentId)return failure('CONFLICT','邮件分析已变化，请刷新后重试');
      const event=(await c.query('SELECT event_id,kind,direction,from_email,subject FROM crm_contact_mail_events WHERE actor_id=$1 AND contact_id=$2 AND customer_id=$3 AND mailbox_key=$4 AND message_key=$5 ORDER BY recorded_at DESC,event_id DESC LIMIT 1',[actorId,input.contactId,input.customerId,input.mailboxKey,input.messageKey])).rows[0];
      if(!event)return failure('NOT_FOUND','邮件证据不存在');
      const contact=await loadContactIn(c,input),state=contactStateForMail(event.kind,event.direction,event.from_email,contact?.email??null);
      return insertAnalysisIn(c,{...input,actorId,eventId:String(event.event_id),threadKey:String(current.threadKey),analyzerVersion:'human-v1',inputSequence:Number(current.inputSequence)+1,source:'human',contactState:state});
    },tokenHash);
  }
}
