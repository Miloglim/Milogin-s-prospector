import { failure } from '../core/crm';
import { CAMPAIGN_LIMITS, CAMPAIGN_ROUTES } from '../core/campaigns';
import type { CampaignService } from '../services/campaigns';
import { body, send, type BrowserHandler } from './http';

export function createCampaignHandler(service:CampaignService):BrowserHandler{return async(request,response)=>{
 const url=new URL(request.url??'/','http://localhost'),token=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization??'')?.[1]??'';
 const prefix=`${CAMPAIGN_ROUTES.campaigns}/`,parts=url.pathname.slice(prefix.length).split('/');
 if(request.method==='GET'&&url.pathname===CAMPAIGN_ROUTES.campaigns){send(response,await service.list(token,{limit:Number(url.searchParams.get('limit')??CAMPAIGN_LIMITS.page),offset:Number(url.searchParams.get('offset')??0),...(url.searchParams.has('state')?{state:url.searchParams.get('state') as never}:{})}));return;}
 if(request.method==='GET'&&url.pathname.startsWith(prefix)&&parts.length===1){send(response,await service.detail(token,parts[0]!));return;}
 if(request.method==='POST'){const input=await body(request,4096);if(!input.ok){send(response,input);return;}if(url.pathname===CAMPAIGN_ROUTES.campaigns){send(response,await service.create(token,input.data));return;}if(parts.length===2&&parts[1]===CAMPAIGN_ROUTES.confirm){send(response,await service.confirm(token,{...(input.data as object),campaignId:parts[0]}));return;}if(parts.length===2&&parts[1]===CAMPAIGN_ROUTES.pause){send(response,await service.pause(token,{...(input.data as object),campaignId:parts[0]}));return;}if(parts.length===2&&parts[1]==='targets'){send(response,await service.addTargets(token,{...(input.data as object),campaignId:parts[0]}));return;}if(url.pathname===`${CAMPAIGN_ROUTES.campaigns}/${CAMPAIGN_ROUTES.dryRunClaim}`){send(response,await service.claimDryRun(token,input.data));return;}if(parts.length===2&&parts[1]==='dry-run-complete'){send(response,await service.completeDryRun(token,input.data));return;}}
 send(response,failure('NOT_FOUND','自动开发任务接口不存在'));
};}
