import {createLifecycleHandler} from './crm-lifecycle-http';
import {COMPANY_ROUTE,CONTACT_DELETE_ROUTE} from '../core/crm-lifecycle';
import {failure} from '../core/crm';
import {CONTACT_ASSIGNMENT_ROUTES} from '../core/contact-assignments';
import {LEAD_LIMITS} from '../core/leads';
import type {ContactAssignmentService} from '../services/contact-assignments';
import {body,send,type BrowserHandler} from './http';
export function createContactAssignmentHandler(service:ContactAssignmentService):BrowserHandler{return async(req,res)=>{
 const url=new URL(req.url??'/',`http://${req.headers.host}`),path=url.pathname,token=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization??'')?.[1]??'';
 if(path===CONTACT_DELETE_ROUTE||path===COMPANY_ROUTE||path.startsWith(COMPANY_ROUTE+'/')){await createLifecycleHandler(service)(req,res);return;}
 if(req.method==='GET'&&path===CONTACT_ASSIGNMENT_ROUTES.assignments){const query:Record<string,unknown>={};for(const [k,v] of url.searchParams){if(k in query){send(res,failure('INVALID_INPUT','查询参数重复'));return;}query[k]=['limit','offset'].includes(k)?Number(v):v;}send(res,await service.assignments(token,query));return;}
 const contact=/^\/api\/crm\/contacts\/(\d+)(?:\/(update|followups|company))?$/.exec(path);
 if(req.method==='GET'&&contact&&!contact[2]){if([...url.searchParams.keys()].some(k=>k!=='customerId')||url.searchParams.getAll('customerId').length!==1){send(res,failure('INVALID_INPUT','联系人参数无效'));return;}send(res,await service.contactDetail(token,{contactId:Number(contact[1]),customerId:url.searchParams.get('customerId')}));return;}
 if(req.method==='POST'){
  const parsed=await body(req,LEAD_LIMITS.bodyBytes);if(!parsed.ok){send(res,parsed);return;}
  if(path===CONTACT_ASSIGNMENT_ROUTES.assignments){send(res,await service.createAssignments(token,parsed.data));return;}
  const decision=/^\/api\/crm\/contact-assignments\/([^/]+)\/(accept|reject|cancel)$/.exec(path),field=decision?'requestId':'contactId',id=decision?decision[1]:contact?Number(contact[1]):undefined;
  if(decision||contact?.[2]){if(!parsed.data||typeof parsed.data!=='object'||Array.isArray(parsed.data)||field in parsed.data&&(parsed.data as Record<string,unknown>)[field]!==id){send(res,failure('INVALID_INPUT','路径与编号不一致'));return;}const input={...parsed.data,[field]:id};send(res,decision?await service.decide(token,decision[2] as 'accept'|'reject'|'cancel',input):contact![2]==='company'?await service.companyUpdate(token,input):contact![2]==='update'?await service.contactUpdate(token,input):await service.contactFollowup(token,input));return;}
 }send(res,failure('NOT_FOUND','联系人接口不存在'));
};}
