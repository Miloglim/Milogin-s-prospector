import {failure} from '../core/crm';
import {LEAD_LIMITS,LEAD_ROUTES,type LeadQuery} from '../core/leads';
import {WORKBOOK_IMPORT_ROUTE} from '../core/customer-import';
import type {LeadService} from '../services/leads';
import {body,send,type BrowserHandler} from './http';
import {CENTER_CONTACT_GROUP_ROUTE,CENTER_CONTACT_ROUTE} from '../core/center-contacts';
export function createCrmHandler(service:LeadService):BrowserHandler{return async(request,response)=>{
 const url=new URL(request.url??'/',`http://${request.headers.host}`),path=url.pathname,method=request.method;
 const token=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization??'')?.[1]??'';
 if(method==='GET'&&path===CENTER_CONTACT_ROUTE){
  const query:Record<string,unknown>={};
  for(const [key,value] of url.searchParams){if(key in query){send(response,failure('INVALID_INPUT','联系人查询参数重复'));return;}query[key]=['limit','offset'].includes(key)?Number(value):key==='followupOnly'?(value==='true'?true:value==='false'?false:value):value;}
  send(response,await service.contacts(token,query));return;
 }
 if(method==='GET'&&path===CENTER_CONTACT_GROUP_ROUTE){
  const query:Record<string,unknown>={};
  for(const [key,value] of url.searchParams){if(key in query){send(response,failure('INVALID_INPUT','联系人分组查询参数重复'));return;}query[key]=['limit','offset'].includes(key)?Number(value):value;}
  send(response,await service.contactGroups(token,query));return;
 }
 if(method==='GET'&&path===LEAD_ROUTES.members){send(response,await service.members(token,{search:url.searchParams.get('search')??'',limit:Number(url.searchParams.get('limit')??LEAD_LIMITS.page),offset:Number(url.searchParams.get('offset')??0)}));return;}
 if(method==='GET'&&path===LEAD_ROUTES.bootstrap){send(response,await service.bootstrap(token));return;}
 if(method==='GET'&&path===LEAD_ROUTES.leads){send(response,await service.list(token,{view:(url.searchParams.get('view')??'mine') as LeadQuery['view'],search:url.searchParams.get('search')??'',limit:Number(url.searchParams.get('limit')??LEAD_LIMITS.page),offset:Number(url.searchParams.get('offset')??0),...(url.searchParams.has('assignment')?{assignment:url.searchParams.get('assignment') as LeadQuery['assignment']} : {}),...(url.searchParams.has('followupOnly')?{followupOnly:url.searchParams.get('followupOnly')==='true'?true:url.searchParams.get('followupOnly')==='false'?false:url.searchParams.get('followupOnly') as unknown as boolean} : {}),...(url.searchParams.has('stage')?{stage:url.searchParams.get('stage') as LeadQuery['stage']} : {})}));return;}
 const detail=/^\/api\/crm\/leads\/([^/]+)$/.exec(path);if(method==='GET'&&detail){send(response,await service.detail(token,detail[1]!));return;}
 if(method==='POST'){const input=await body(request,LEAD_LIMITS.bodyBytes);if(!input.ok){send(response,input);return;}
  if(path===LEAD_ROUTES.leads){send(response,await service.createCustomer(token,input.data));return;}
  if(path===LEAD_ROUTES.imports){send(response,await service.importRows(token,input.data));return;}
  if(path===WORKBOOK_IMPORT_ROUTE){send(response,await service.importWorkbook(token,input.data));return;}
  const publish=/^\/api\/crm\/imports\/([^/]+)\/publish$/.exec(path);if(publish){send(response,await service.publish(token,publish[1]!,input.data));return;}
  const action=/^\/api\/crm\/leads\/([^/]+)\/(claim|followups|update|assign)$/.exec(path);if(action){if(!input.data||typeof input.data!=='object'||Array.isArray(input.data)||'customerId'in input.data&&(input.data as {customerId:unknown}).customerId!==action[1]){send(response,failure('INVALID_INPUT','路径与客户编号不一致'));return;}const v={...input.data,customerId:action[1]};send(response,action[2]===LEAD_ROUTES.assignAction?await service.assign(token,v):action[2]==='claim'?await service.claim(token,v):action[2]==='update'?await service.updateCustomer(token,v):await service.followup(token,v));return;}
 }
 send(response,failure('NOT_FOUND','CRM接口不存在'));
};}
