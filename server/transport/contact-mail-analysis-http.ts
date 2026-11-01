import { failure } from '../core/crm';
import { CONTACT_MAIL_ANALYSIS_LIMITS, CONTACT_MAIL_ANALYSIS_ROUTES } from '../core/mail-analysis';
import type { ContactMailAnalysisService } from '../services/contact-mail-analysis';
import { body, send, type BrowserHandler } from './http';

const TOKEN = /^Bearer ([A-Za-z0-9_-]{43})$/;
const QUERY_FIELDS = ['contactId','customerId','mailboxKey','messageKey','contentHash','history','limit'] as const;

function bearer(value:string|undefined):string { return TOKEN.exec(value??'')?.[1]??''; }

export function createContactMailAnalysisHandler(service:ContactMailAnalysisService):BrowserHandler {
  return async (request,response)=>{
    const url=new URL(request.url??'/','http://localhost'),token=bearer(request.headers.authorization);
    if(!token){send(response,failure('UNAUTHORIZED','会话无效'));return;}
    if(url.pathname===CONTACT_MAIL_ANALYSIS_ROUTES.analyses){
      if(request.method!=='GET'){send(response,failure('NOT_FOUND','邮件分析接口不存在'));return;}
      if([...url.searchParams.keys()].some(key=>!QUERY_FIELDS.includes(key as never)||url.searchParams.getAll(key).length!==1)){send(response,failure('INVALID_INPUT','邮件分析查询参数无效'));return;}
      const contactId=Number(url.searchParams.get('contactId')),limit=Number(url.searchParams.get('limit')??'20');
      send(response,await service.current(token,{
        contactId,customerId:url.searchParams.get('customerId')??'',mailboxKey:url.searchParams.get('mailboxKey')??'',
        messageKey:url.searchParams.get('messageKey')??'',contentHash:url.searchParams.get('contentHash')??'',
        includeHistory:url.searchParams.get('history')==='true',historyLimit:limit,
      }));return;
    }
    if(url.search){send(response,failure('INVALID_INPUT','邮件分析写入不接受查询参数'));return;}
    if(request.method!=='POST'||![CONTACT_MAIL_ANALYSIS_ROUTES.ai,CONTACT_MAIL_ANALYSIS_ROUTES.correct].includes(url.pathname as never)){send(response,failure('NOT_FOUND','邮件分析接口不存在'));return;}
    const parsed=await body(request,CONTACT_MAIL_ANALYSIS_LIMITS.bodyBytes);
    if(!parsed.ok){send(response,parsed);return;}
    send(response,url.pathname===CONTACT_MAIL_ANALYSIS_ROUTES.ai?await service.submitAI(token,parsed.data):await service.correct(token,parsed.data));
  };
}
