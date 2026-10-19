import { failure, success, type Result } from '../../../server/core/crm';
import { importRowIssue, type CustomerCreate, type CustomerUpdate, type FollowupRequest, type ImportRequest, type ImportReceipt, type LeadDetail, type LeadRepository } from '../../../server/core/leads';
import { createLeadService } from '../../../server/services/leads';
import { AUTH_LIMITS } from '../../../server/core/auth';
import type { OfflineCrmContext, OfflineCrmState } from '../core/offline-crm';

const VALIDATION_TOKEN = 'A'.repeat(AUTH_LIMITS.tokenCharacters);
/** Reuses center input validation; the repository below only mutates the transaction draft. */
export async function queueCrmMutation(state:OfflineCrmState,ctx:OfflineCrmContext,path:string,body:unknown,uuid:()=>string,now:()=>string):Promise<Result<unknown>> {
  if(!state.bootstrap)return failure('UNAVAILABLE','请先联网完成客户数据同步');
  const permission=(name:string)=>state.bootstrap!.capabilities.includes(name);
  const forbidden=()=>Promise.resolve(failure('FORBIDDEN','当前账号没有此操作权限'));
  const record=body as Record<string,unknown>;
  const route=/^\/api\/crm\/leads\/([^/]+)\/(update|followups)$/.exec(path);
  if(route && record?.customerId!==route[1])return failure('INVALID_INPUT','路径与客户编号不一致');
  const originalId=String(record?.customerId??'');
  const id=state.aliases[originalId]??originalId;
  const payload=route?{...record,customerId:id}:body;
  const normalizedPath=route?`/api/crm/leads/${id}/${route[2]}`:path;
  const digest=JSON.stringify({path,body});
  const key=String(record?.idempotencyKey??'');
  const receiptKey=`${path}:${key}`;
  const old=state.receipts[receiptKey];
  if(old)return old.digest===digest?success(structuredClone(old.response)):failure('CONFLICT','幂等键已用于不同请求');
  const entities:string[]=[];
  const target=()=>{
    const item=state.customers[id];
    if(!item)return failure('NOT_FOUND','本地没有此客户，请联网同步');
    if(!permission('leads.develop'))return failure('FORBIDDEN','无客户修改权限');
    const allowed=route?.[2]==='followups'?item.canFollowup:item.canEdit;
    if(!(allowed??item.ownerUserId===ctx.userId))return failure('FORBIDDEN','此客户不可编辑');
    if(item.version!==record.expectedVersion)return failure('CONFLICT','本地客户已变化，请刷新后重试');
    if(state.outbox.some(op=>op.entities.includes(id)&&op.status!=='pending'))return failure('CONFLICT','请先处理此客户的同步问题');
    return success(item);
  };
  function make(input:CustomerCreate,origin:'personal'|'operations'='personal',customerKey?:string):LeadDetail {
    const customerId=uuid();
    const contacts=input.contacts.map(c=>({contactId:state.nextContactId++,email:c.email.trim().toLowerCase(),name:c.name??null,country:c.country??null,phone:c.phone??null,title:c.title??null,touchStatus:'uncontacted' as const}));
    const item:LeadDetail={customerId,companyName:input.companyName.trim(),country:input.country??null,version:1,origin,state:origin==='personal'?'owned':'draft',stage:'cold',ownerUserId:origin==='personal'?ctx.userId:null,source:input.source,sourceDetail:input.sourceDetail,customerKey:customerKey??customerId,contacts,contactCount:contacts.length,activities:[],canEdit:permission('leads.develop'),canFollowup:permission('leads.develop'),canAssign:false,businessType:input.businessType,developmentRestriction:input.developmentRestriction,sourceCreatedAt:input.sourceCreatedAt,primaryContactName:contacts[0]?.name,primaryContactEmail:contacts[0]?.email};
    state.customers[customerId]=item;entities.push(customerId);return item;
  }
  function emailCollision(emails:string[],except?:string):boolean {
    const normalized=emails.map(e=>e.trim().toLowerCase()).filter(Boolean);
    return Object.values(state.customers).some(c=>c.customerId!==except&&c.contacts.some(contact=>normalized.includes((contact.email??'').toLowerCase())));
  }
  const unsupported=()=>Promise.resolve(failure('UNAVAILABLE','此操作需要联网'));
  const repo:LeadRepository={bootstrap:unsupported,list:unsupported,detail:unsupported,publish:unsupported,claim:unsupported,
    createCustomer:(_hash,input:CustomerCreate)=>{
      if(!permission('leads.create')||!permission('leads.develop'))return forbidden();
      if(emailCollision(input.contacts.map(c=>c.email)))return Promise.resolve(failure('CONFLICT','本地已有相同邮箱，请核对客户'));
      return Promise.resolve(success(make(input)));
    },
    updateCustomer:(_hash,input:CustomerUpdate)=>{
      const result=target();if(!result.ok)return Promise.resolve(result);const item=result.data;
      const ids=input.contacts.map(c=>c.contactId).filter(c=>c!==undefined);
      if(new Set(ids).size!==ids.length||item.contacts.some(c=>!ids.includes(c.contactId))||ids.some(cid=>!item.contacts.some(c=>c.contactId===cid)))return Promise.resolve(failure('CONFLICT','已有联系人必须携带原编号并全部保留'));
      if(emailCollision(input.contacts.map(c=>c.email),id))return Promise.resolve(failure('CONFLICT','本地已有相同邮箱，请核对客户'));
      item.companyName=input.companyName.trim();item.country=input.country??null;
      for(const field of ['businessType','developmentRestriction','sourceCreatedAt'] as const)if(input[field]!==undefined)item[field]=input[field];
      item.contacts=input.contacts.map(c=>({contactId:c.contactId??state.nextContactId++,email:c.email.trim().toLowerCase(),name:c.name??null,country:c.country??null,phone:c.phone??null,title:c.title??null,touchStatus:item.contacts.find(old=>old.contactId===c.contactId)?.touchStatus??'uncontacted'}));
      item.contactCount=item.contacts.length;item.primaryContactName=item.contacts[0]?.name;item.primaryContactEmail=item.contacts[0]?.email;item.version++;entities.push(id);
      return Promise.resolve(success(item));
    },
    followup:(_hash,input:FollowupRequest)=>{
      const result=target();if(!result.ok)return Promise.resolve(result);const item=result.data;
      if(item.canFollowup===false)return forbidden();
      const contact=input.contactId?item.contacts.find(c=>c.contactId===input.contactId):undefined;
      if(input.contactId&&!contact)return Promise.resolve(failure('INVALID_INPUT','联系人不属于此客户'));
      if(input.opportunityId)return Promise.resolve(failure('UNAVAILABLE','关联商机的跟进请联网保存'));
      const time=now();const occurredAt=input.occurredAt??time;
      item.activities.unshift({id:uuid(),actorId:ctx.userId,note:input.note.trim(),stage:input.stage??null,createdAt:time,method:input.method??'other',occurredAt,recordedAt:time,contactId:input.contactId??null,contactName:contact?.name??null,contactStatus:input.contactStatus??null});
      if(input.stage)item.stage=input.stage;if(contact&&input.contactStatus)contact.touchStatus=input.contactStatus;
      if(input.method!=='note'&&(!item.recentActivityAt||Date.parse(occurredAt)>Date.parse(item.recentActivityAt)))item.recentActivityAt=occurredAt;
      item.version++;entities.push(id);return Promise.resolve(success(item));
    },
    importRows:(_hash,input:ImportRequest)=>{
      const origin=input.kind??'operations';
      if(origin==='personal'&&(!permission('leads.create')||!permission('leads.develop')) || origin==='operations'&&(!permission('leads.import')||!['shared','summary'].includes(state.bootstrap!.scope)))return forbidden();
      const receipt:ImportReceipt={batchId:uuid(),version:1,rows:[]};
      input.rows.forEach((row,index)=>{
        const rowId=uuid(),issue=importRowIssue(row);
        if(issue){receipt.rows.push({rowId,index,status:'invalid',message:issue});return;}
        const existing=Object.values(state.customers).find(c=>c.origin===origin&&c.source===input.source&&c.customerKey===row.customerKey);
        if(existing){receipt.rows.push({rowId,index,status:'duplicate',customerId:existing.customerId});return;}
        if(emailCollision([row.email])){receipt.rows.push({rowId,index,status:'restricted_conflict',message:'本地已有相同邮箱'});return;}
        const item=make({companyName:row.companyName,country:row.country,source:input.source,sourceDetail:input.sourceDetail,contacts:[{email:row.email,name:row.name,country:row.country}],idempotencyKey:input.idempotencyKey},origin,row.customerKey);
        receipt.rows.push({rowId,index,status:'created',customerId:item.customerId});
      });
      return Promise.resolve(success(receipt));
    },
  };
  const service=createLeadService(repo,{create:()=>VALIDATION_TOKEN,hash:value=>value});
  const result=path==='/api/crm/leads'?await service.createCustomer(VALIDATION_TOKEN,payload):path==='/api/crm/imports'?await service.importRows(VALIDATION_TOKEN,payload):route?.[2]==='update'?await service.updateCustomer(VALIDATION_TOKEN,payload):route?.[2]==='followups'?await service.followup(VALIDATION_TOKEN,payload):failure('UNAVAILABLE','此操作需要联网');
  if(!result.ok)return result;
  const dependency=state.outbox.filter(op=>op.entities.some(entity=>entities.includes(entity))).at(-1)?.id;
  const response=structuredClone(result.data);
  const queuedBody=structuredClone(payload as Record<string,unknown>);
  if(route?.[2]==='followups'&&queuedBody.occurredAt===undefined)queuedBody.occurredAt=(result.data as LeadDetail).activities[0]!.occurredAt;
  state.outbox.push({id:uuid(),method:'POST',path:normalizedPath,body:queuedBody,entities,dependency,status:'pending',response});
  state.receipts[receiptKey]={digest,response};
  return success(response);
}
