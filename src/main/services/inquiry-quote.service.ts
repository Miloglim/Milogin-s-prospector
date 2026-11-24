import type { CenterContact, CenterContactRef, QuoteCaseDetail, QuoteFields, QuoteFieldValue, QuoteCandidate, SalesCase } from '../../shared/online-crm';
import { CENTER_CONTACT_ROUTE, CENTER_CONTACT_LIMITS } from '../../../server/core/center-contacts';
import { missingQuoteFields, type QuoteFieldKey } from '../../../server/core/quote-case';
import { getRawDb } from '../db';
import { htmlToText } from '../core/html-text';
import { listInboxAnalysisViews } from './inbox-analysis.service';
import * as InboxService from './inbox.service';
import { Log } from '../logger';
import { lookupReplyRates } from './agent/reply-rates';
import { normContainer, parseEmailInquiry, type EmailInquiry } from './agent/email-parse';
import { inboxQuoteCard, saveInboxQuoteCard } from '../core/inquiry-quote-storage';
import type { InboxQuoteCard, InboxQuoteCandidate } from '../../shared/inbox';
import { salesWorkflowClient } from './sales-workflow-client.service';
import { chatJson, generateEmailReply, isAiConfigured } from './ai.service';
import { failResult, okResult, type Result } from '../errors';

const INQUIRY_CATEGORIES = new Set(['price_inquiry', 'quote_request']);
const MAX_FIELD_TEXT = 500;
const MAX_BODY = 30_000;

interface MailRow { id:number; accountId:number; fromEmail:string; subject:string|null; bodyPreview:string|null; messageId:string|null; matchedContactId:number|null; accountEmail?:string|null; }

function domain(email:string):string { return email.trim().toLowerCase().split('@')[1] || ''; }
function safeText(value:string|null|undefined,max=MAX_FIELD_TEXT):string|null { const text=(value||'').trim(); return text?text.slice(0,max):null; }
function value(fields:QuoteFields,key:QuoteFieldKey):string|string[]|null { const item=fields[key]; return item?.value??null; }
function field(value:string|string[]|null,evidence:string[],confidence=0.8):QuoteFieldValue|undefined {
  if(value===null||value===''||Array.isArray(value)&&!value.length)return undefined;
  return { value,source:'email',evidence,confidence,resolver:null };
}

function localFields(inquiry:EmailInquiry,evidence:string[]):QuoteFields {
  const fields:QuoteFields={};
  if(inquiry.pol)fields.pol=field(inquiry.pol,evidence);
  if(inquiry.pod)fields.pod=field(inquiry.pod,evidence);
  if(inquiry.container)fields.containerTypes=field([inquiry.container],evidence,0.9);
  if(inquiry.cargo)fields.commodity=field(inquiry.cargo,evidence);
  if(inquiry.volumeCbm)fields.weight=field(`${inquiry.volumeCbm} CBM`,evidence,0.7);
  if(inquiry.incoterm)fields.incoterm=field(inquiry.incoterm,evidence);
  if(inquiry.quoteRef)fields.validity=field(inquiry.quoteRef,evidence,0.4);
  return fields;
}

function candidateFromRate(row: any):QuoteCandidate {
  const pod=(row.podRaw??row.pod??null) as string|null;
  const id=`rate:${row.sourceGroup??''}:${row.carrier??''}:${row.pol??''}:${pod??''}:${row.container??''}:${row.oceanUsd??''}:${row.validTo??''}`;
  return { id,carrier:safeText(row.carrier,120),pol:safeText(row.pol,160),pod:safeText(pod,160),containerType:safeText(row.container,40),
    price:typeof row.oceanUsd==='number'?row.oceanUsd:null,currency:'USD',etd:safeText(row.etd,80),validFrom:safeText(row.validFrom,80),validTo:safeText(row.validTo,80),
    sourceUpdatedAt:safeText(row.syncedAt??row.sourceUpdatedAt,80),evidence:[] };
}

function localCardCandidate(candidate:QuoteCandidate):InboxQuoteCandidate {
  return {...candidate,evidence:candidate.evidence};
}

function fieldsForCenter(fields:QuoteFields):Record<string,unknown> {return fields as Record<string,unknown>;}

async function enrichWithModel(base:QuoteFields,text:string):Promise<QuoteFields>{
  if(!isAiConfigured())return base;
  if(value(base,'pol')&&value(base,'pod'))return base;
  try{
    const result=await chatJson<unknown>([
      '你是货代询价字段抽取器。只输出 JSON，不要解释。',
      '只允许从原文逐字提取，不得猜测或补全。无法确认的字段填 null。',
      '字段：pol,pod,containerTypes,commodity,weight,incoterm。containerTypes 数组；pol/pod 使用原文中的港名或 LOCODE。',
    ].join('\n'),`邮件正文：\n${text}\n\n输出：{"pol":null,"pod":null,"containerTypes":[],"commodity":null,"weight":null,"incoterm":null}`);
    if(!result.success||!result.data||typeof result.data!=='object'||Array.isArray(result.data))return base;
    const output=result.data as Record<string,unknown>;
    const merged={...base};
    const add=(key:QuoteFieldKey, raw:unknown)=>{
      if(merged[key])return;
      if(typeof raw==='string'){
        const textRaw=raw.trim();if(!textRaw||textRaw.length>MAX_FIELD_TEXT||!text.toUpperCase().includes(textRaw.toUpperCase()))return;
        merged[key]=field(key==='containerTypes'?[normContainer(textRaw)||textRaw]:textRaw,[textRaw],0.75);
      } else if(key==='containerTypes'&&Array.isArray(raw)){
        const containers=raw.filter(item=>typeof item==='string'&&item.trim()).map(item=>normContainer(item)!).filter((item):item is string=>!!item);
        if(containers.length)merged.containerTypes=field(containers,containers,0.75);
      }
    };
    add('pol',output.pol);add('pod',output.pod);add('containerTypes',output.containerTypes);add('commodity',output.commodity);add('weight',output.weight);add('incoterm',output.incoterm);
    return merged;
  }catch(error){Log.warn('quote.extract',`询价字段模型校验跳过: ${error instanceof Error?error.message:String(error)}`);return base;}
}

async function findContact(client:NonNullable<ReturnType<typeof salesWorkflowClient>>,fromEmail:string):Promise<CenterContact|null>{
  const result=await client.contacts?.({search:fromEmail,limit:10,offset:0});
  if(!result?.ok)return null;
  return result.data.items.find(item=>item.email?.trim().toLowerCase()===fromEmail.trim().toLowerCase())??null;
}

export interface InquiryQuoteRuntime {
  onUpdated?: (messageId:number)=>void;
}

export function createInquiryQuoteService(runtime:InquiryQuoteRuntime={}){
  const running=new Set<number>();
  return {
    async analyze(messageId:number):Promise<InboxQuoteCard|null>{
      if(!Number.isSafeInteger(messageId)||messageId<1||running.has(messageId))return null;
      running.add(messageId);
      try{
        const raw=getRawDb();
        const mail=raw.prepare(`SELECT i.id,i.account_id AS accountId,i.from_email AS fromEmail,i.subject,i.body_preview AS bodyPreview,i.message_id AS messageId,i.matched_contact_id AS matchedContactId,a.email AS accountEmail
          FROM inbox_messages i LEFT JOIN email_accounts a ON a.id=i.account_id WHERE i.id=?`).get(messageId) as MailRow|undefined;
        if(!mail)return null;
        const analysis=listInboxAnalysisViews([messageId]).get(messageId);
        if(!analysis||analysis.status!=='ready'||!analysis.requiresAction||!INQUIRY_CATEGORIES.has(analysis.category))return null;
        if(domain(mail.fromEmail)&&domain(mail.fromEmail)===domain(mail.accountEmail||''))return null;
        const existing=inboxQuoteCard(messageId);
        if(existing&&!['failed','stale'].includes(existing.state))return existing;
        const client=salesWorkflowClient();if(!client)return null;
        const body=await InboxService.getBody(messageId);
        const plain=htmlToText(body.success?body.data:mail.bodyPreview||'').slice(0,MAX_BODY);
        const local=parseEmailInquiry(plain);
        const fields=await enrichWithModel(localFields(local,analysis.evidence),plain);
        const linked=raw.prepare('SELECT contact_id AS contactId,customer_id AS customerId FROM crm_contact_mail_links WHERE local_mail_id=? ORDER BY role=\'primary\' DESC LIMIT 1').get(messageId) as {contactId:number;customerId:string}|undefined;
        const contact=await findContact(client,mail.fromEmail);
        const ref:CenterContactRef=contact?{contactId:contact.contactId,customerId:contact.customerId}:linked?{contactId:Number(linked.contactId),customerId:linked.customerId}:{contactId:0,customerId:''};
        if(!ref.contactId||!ref.customerId){const failed:InboxQuoteCard={messageId,messageKey:mail.messageId||String(messageId),caseId:'',quoteCaseId:'',quoteId:'',state:'unmatched',fields:fieldsForCenter(fields),missingFields:missingQuoteFields(fields),selectedCandidate:null,candidates:[],summary:analysis.summary,error:'未找到对应中心联系人',updatedAt:new Date().toISOString()};saveInboxQuoteCard(failed);runtime.onUpdated?.(messageId);return failed;}
        const ensured=await client.request<SalesCase>('POST','/api/crm/sales-cases/ensure',{...ref,source:'inquiry'},true);
        if(!ensured.ok)throw new Error(ensured.error.message);
        await client.request('POST',`/api/crm/sales-cases/${encodeURIComponent(ensured.data.caseId)}/transition`,{state:'inquiry_detected',nextAction:'确认运输需求',summary:analysis.summary,eventType:'inquiry.detected',payload:{messageKey:mail.messageId||String(messageId)}},true);
        const missing=missingQuoteFields(fields);
        let candidates:QuoteCandidate[]=[];let state:'fields_pending'|'ready'|'failed'='fields_pending';let centerState:'fields_pending'|'candidates_ready'|'querying'='fields_pending';let error:string|null=null;
        if(!missing.includes('pol')&&!missing.includes('pod')){
          state='ready';centerState='querying';
          try{
            const rates=await lookupReplyRates(local,12);
            candidates=(rates?.dtos??[]).map(candidateFromRate);
            centerState='candidates_ready';
          }catch(queryError){state='failed';error=queryError instanceof Error?queryError.message:'运价查询暂不可用';}
        }
        await client.request('POST',`/api/crm/sales-cases/${encodeURIComponent(ensured.data.caseId)}/transition`,{state:'quote_preparing',nextAction:state==='ready'?'确认报价':'补充运输需求',summary:analysis.summary,eventType:'quote.requested'},true);
        const subject=mail.subject||'';
        const threadKey=`${mail.fromEmail.toLowerCase()}::${subject.replace(/^((re|fw|fwd)\s*[:：]\s*)+/i,'').trim().toLowerCase()||`message:${messageId}`}`;
        const quote=await client.request<QuoteCaseDetail>('POST','/api/crm/quote-cases/upsert',{
          caseId:ensured.data.caseId,messageKey:mail.messageId||String(messageId),threadKey,fields:fieldsForCenter(fields),missingFields:missing,
          state:centerState,selectedCandidate:null,candidates,subject,body:null,reason:'inquiry_background_prepare',
        },true);
        if(!quote.ok){state='failed';error=quote.error.message;}
        const card:InboxQuoteCard={messageId,messageKey:mail.messageId||String(messageId),caseId:ensured.data.caseId,quoteCaseId:quote.ok?quote.data.quoteCase.quoteCaseId:'',quoteId:quote.ok?quote.data.draft.quoteId:'',state,fields:fieldsForCenter(fields),missingFields:missing,selectedCandidate:null,candidates:candidates.map(localCardCandidate),summary:analysis.summary,error:error||(!quote.ok?quote.error.message:null),updatedAt:new Date().toISOString()};
        saveInboxQuoteCard(card);runtime.onUpdated?.(messageId);return card;
      }catch(error){Log.warn('quote.background',`询价准备失败 message=${messageId}: ${error instanceof Error?error.message:String(error)}`);return null;}
      finally{running.delete(messageId);}
    },
    async select(messageId:number,candidateId:string):Promise<Result<InboxQuoteCard>>{
      const card=inboxQuoteCard(messageId);const client=salesWorkflowClient();
      if(!card||!client)return failResult('报价卡不存在');
      const selected=card.candidates.find(item=>item.id===candidateId);
      if(!selected||!card.quoteCaseId)return failResult('报价候选不存在');
      const result=await client.request<QuoteCaseDetail>('POST',`/api/crm/quote-cases/${encodeURIComponent(card.quoteCaseId)}/select`,selected,true);
      if(!result?.ok)return failResult(result?.error?.message||'报价选择暂不可用');
      const updated={...card,selectedCandidate:selected,state:'ready' as const,error:null,updatedAt:new Date().toISOString()};saveInboxQuoteCard(updated);runtime.onUpdated?.(messageId);return okResult(updated);
    },
    async requery(messageId:number,edits:Record<string,string|string[]>):Promise<Result<InboxQuoteCard>>{
      const card=inboxQuoteCard(messageId);const client=salesWorkflowClient();
      if(!card||!client)return failResult('报价卡不存在');
      const fields:QuoteFields={...(card.fields as QuoteFields)};
      for(const [key,raw] of Object.entries(edits)){
        if(!(['pol','pod','containerTypes','quantity','commodity','weight','carrierPreference','carrierExclusion','etd','validity','incoterm','specialRequirements','targetPrice'] as string[]).includes(key))continue;
        if(typeof raw!=='string'&&!Array.isArray(raw))continue;
        fields[key as QuoteFieldKey]={value:raw,source:'user',evidence:[],confidence:1,resolver:null};
      }
      const pick=(key:QuoteFieldKey)=>{const raw=fields[key]?.value;return Array.isArray(raw)?raw[0]??null:raw??null;};
      const inquiry:EmailInquiry={container:pick('containerTypes'),containerRaw:pick('containerTypes'),pol:pick('pol'),polCode:null,pod:pick('pod'),podCode:null,incoterm:pick('incoterm'),cargo:pick('commodity'),cargoValueUsd:null,quoteRef:null,volumeCbm:null,weightKg:null};
      const missing=missingQuoteFields(fields);
      let candidates:QuoteCandidate[]=[];
      let localState:'fields_pending'|'ready'|'failed'='fields_pending';let centerState:'fields_pending'|'candidates_ready'|'querying'|'draft_ready'='fields_pending';let error:string|null=null;
      if(!missing.includes('pol')&&!missing.includes('pod')){
        centerState='querying';
        try{const rates=await lookupReplyRates(inquiry,12);candidates=(rates?.dtos??[]).map(candidateFromRate);localState='ready';centerState='candidates_ready';}catch(err){localState='failed';error=err instanceof Error?err.message:'运价查询暂不可用';}
      }
      const result=card.quoteCaseId
        ? await client.request<QuoteCaseDetail>('POST',`/api/crm/quote-cases/${encodeURIComponent(card.quoteCaseId)}/requery`,{fields,missingFields:missing,candidates,state:centerState,selectedCandidate:null,reason:'user_fields_changed'},true)
        : await client.request<QuoteCaseDetail>('POST','/api/crm/quote-cases/upsert',{caseId:card.caseId,messageKey:card.messageKey,threadKey:`${card.messageKey}`,fields,missingFields:missing,state:centerState,selectedCandidate:null,candidates,reason:'user_fields_changed'},true);
      if(!result.ok){localState='failed';error=result.error.message;}
      const updated:InboxQuoteCard={...card,state:localState,fields:fieldsForCenter(fields),missingFields:missing,selectedCandidate:null,candidates:candidates.map(localCardCandidate),quoteCaseId:result.ok?result.data.quoteCase.quoteCaseId:card.quoteCaseId,quoteId:result.ok?result.data.draft.quoteId:card.quoteId,error,updatedAt:new Date().toISOString()};saveInboxQuoteCard(updated);runtime.onUpdated?.(messageId);return okResult(updated);
    },
    async draft(messageId:number):Promise<Result<{subject:string;body:string}>>{
      const card=inboxQuoteCard(messageId);const client=salesWorkflowClient();
      if(!card||!client)return failResult('报价卡不存在');
      if(!card.selectedCandidate)return failResult('先选择一条报价');
      const raw=getRawDb().prepare('SELECT from_email AS fromEmail,subject,body_preview AS bodyPreview FROM inbox_messages WHERE id=?').get(messageId) as {fromEmail:string;subject:string|null;bodyPreview:string|null}|undefined;
      if(!raw)return failResult('邮件不存在');
      const body=await InboxService.getBody(messageId);const plain=htmlToText(body.success?body.data:raw.bodyPreview||'').slice(0,8000);
      const contact=await findContact(client,raw.fromEmail);
      const rates=(card.selectedCandidate?[card.selectedCandidate]:[]).concat(card.candidates.filter(item=>item.id!==card.selectedCandidate!.id)).map(item=>({carrier:item.carrier,container:item.containerType,pol:item.pol,pod:item.pod,price:item.price,validFrom:item.validFrom,validTo:item.validTo,note:null}));
      const generated=await generateEmailReply({language:'EN',companyName:contact?.companyName||'',contactName:[contact?.firstName,contact?.lastName].filter(Boolean).join(' ')||raw.fromEmail,fromEmail:raw.fromEmail,subject:raw.subject,bodyText:plain,rates,emailFacts:{container:card.selectedCandidate.containerType,pol:card.selectedCandidate.pol,pod:card.selectedCandidate.pod}});
      if(!generated.success)return failResult(generated.error);
      const subjectMatch=generated.data.match(/^(?:SUBJECT|主题)\s*[:：]\s*(.+)$/im);const subject=(subjectMatch?.[1]||`Re: ${raw.subject||''}`).trim();
      const replyBody=generated.data.replace(/^(?:SUBJECT|主题)\s*[:：].*$/im,'').trim();
      if(card.quoteCaseId)await client.request('POST',`/api/crm/quote-cases/${encodeURIComponent(card.quoteCaseId)}/requery`,{fields:card.fields,candidates:card.candidates,selectedCandidate:card.selectedCandidate,state:'draft_ready',subject,body:replyBody,reason:'reply_draft_created'},true);
      return okResult({subject,body:replyBody});
    },
  };
}

export type InquiryQuoteService=ReturnType<typeof createInquiryQuoteService>;
