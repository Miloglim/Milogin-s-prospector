import { failure } from '../core/crm';
import { OPPORTUNITY_LIMITS,OPPORTUNITY_ROUTES } from '../core/opportunities';
import { LEAD_LIMITS } from '../core/leads';
import type { OpportunityService } from '../services/opportunities';
import { body,send,type BrowserHandler } from './http';

export function createOpportunityHandler(service:OpportunityService):BrowserHandler{return async(request,response)=>{
 const url=new URL(request.url??'/','http://localhost'),token=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization??'')?.[1]??'';
 if(request.method==='GET'&&url.pathname===OPPORTUNITY_ROUTES.opportunities){send(response,await service.list(token,{customerId:url.searchParams.get('customerId')??'',limit:Number(url.searchParams.get('limit')??OPPORTUNITY_LIMITS.page),offset:Number(url.searchParams.get('offset')??0)}));return;}
 const prefix=`${OPPORTUNITY_ROUTES.opportunities}/`,parts=url.pathname.slice(prefix.length).split('/');
 if(request.method==='GET'&&url.pathname.startsWith(prefix)&&parts.length===1){send(response,await service.detail(token,parts[0]!));return;}
 if(request.method==='POST'&&(url.pathname===OPPORTUNITY_ROUTES.opportunities||url.pathname.startsWith(prefix)&&parts.length===2&&parts[1]===OPPORTUNITY_ROUTES.stageAction)){
  const input=await body(request,LEAD_LIMITS.bodyBytes);if(!input.ok){send(response,input);return;}
  if(url.pathname===OPPORTUNITY_ROUTES.opportunities){send(response,await service.create(token,input.data));return;}
  if(!input.data||typeof input.data!=='object'||Array.isArray(input.data)||'opportunityId'in input.data&&input.data.opportunityId!==parts[0]){send(response,failure('INVALID_INPUT','路径与商机编号不一致'));return;}
  send(response,await service.updateStage(token,{...input.data,opportunityId:parts[0]}));return;
 }
 send(response,failure('NOT_FOUND','商机接口不存在'));
};}
