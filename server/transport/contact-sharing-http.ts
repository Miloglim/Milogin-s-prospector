import {failure} from '../core/crm';
import {CONTACT_SHARING_ROUTES as ROUTES} from '../core/contact-sharing';
import type {ContactSharingService} from '../services/contact-sharing';
import {body,send,type BrowserHandler} from './http';
import {LEAD_LIMITS} from '../core/leads';
export function createContactSharingHandler(service:ContactSharingService):BrowserHandler{return async(req,res)=>{
 const url=new URL(req.url??'/',`http://${req.headers.host}`),token=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization??'')?.[1]??'',path=url.pathname;
 if(req.method==='GET'&&path===ROUTES.members){send(res,await service.shareMembers(token));return;}
 if(req.method==='GET'&&path===ROUTES.shares){const query:Record<string,unknown>={};for(const [k,v] of url.searchParams){if(k in query){send(res,failure('INVALID_INPUT','查询参数重复'));return;}query[k]=['limit','offset','contactId'].includes(k)?Number(v):v;}send(res,await service.shares(token,query));return;}
 if(req.method==='POST'){
  const parsed=await body(req,LEAD_LIMITS.bodyBytes);if(!parsed.ok){send(res,parsed);return;}
  if(path===ROUTES.shares){send(res,await service.createShare(token,parsed.data));return;}
  const match=/^\/api\/crm\/contact-shares\/([^/]+)\/(accept|reject|revoke|update)$/.exec(path);
  if(match){if(!parsed.data||typeof parsed.data!=='object'||Array.isArray(parsed.data)||'shareId' in parsed.data&&(parsed.data as Record<string,unknown>).shareId!==match[1]){send(res,failure('INVALID_INPUT','路径与编号不一致'));return;}const input={...parsed.data,shareId:match[1]};send(res,match[2]==='update'?await service.updateShare(token,input):await service.decideShare(token,match[2] as 'accept'|'reject'|'revoke',input));return;}
 }send(res,failure('NOT_FOUND','共享接口不存在'));
};}
