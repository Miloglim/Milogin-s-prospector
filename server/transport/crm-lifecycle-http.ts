import { failure } from '../core/crm';
import { COMPANY_ROUTE,CONTACT_DELETE_ROUTE } from '../core/crm-lifecycle';
import type { createLifecycleService } from '../services/crm-lifecycle';
import { LEAD_LIMITS } from '../core/leads';
import { body,send,type BrowserHandler } from './http';
export function createLifecycleHandler(service:ReturnType<typeof createLifecycleService>):BrowserHandler{return async(req,res)=>{
 const url=new URL(req.url??'/','http://localhost'),path=url.pathname,token=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization??'')?.[1]??'';
 const company=/^\/api\/crm\/companies\/(\d+)(?:\/(delete))?$/.exec(path);
 if(req.method==='GET'){
  const q:Record<string,unknown>={};for(const [k,v] of url.searchParams){if(k in q){send(res,failure('INVALID_INPUT','查询参数重复'));return;}q[k]=['limit','offset'].includes(k)?Number(v):v;}
  if(path===COMPANY_ROUTE){send(res,await service.companies(token,q));return;}
  if(company&&!company[2]){if(Object.keys(q).some(k=>k!=='scope')){send(res,failure('INVALID_INPUT','公司参数无效'));return;}send(res,await service.companyDetail(token,{companyId:Number(company[1]),...q}));return;}
 }
 if(req.method==='POST'){
  const p=await body(req,LEAD_LIMITS.bodyBytes);if(!p.ok){send(res,p);return;}
  if(path===CONTACT_DELETE_ROUTE){send(res,await service.deleteContacts(token,p.data));return;}
  if(path===COMPANY_ROUTE){send(res,await service.createCompany(token,p.data));return;}
  if(company?.[2]==='delete'){
   if(!p.data||typeof p.data!=='object'||Array.isArray(p.data)||'companyId' in p.data&&p.data.companyId!==Number(company[1])){send(res,failure('INVALID_INPUT','路径与公司编号不一致'));return;}
   send(res,await service.deleteCompany(token,{...p.data,companyId:Number(company[1])}));return;
  }
 }
 send(res,failure('NOT_FOUND','资料操作接口不存在'));
};}
