import { ONLINE_CHANNELS,type CenterCompanyDetail,type CenterCompanyPage,type CenterCompanyUpdate,type CompanyCreate,type CompanyDelete,type CompanyQuery,type CenterContactDetail } from '../../../shared/online-crm';
import type { CompanyDataPort,CompanyWithCounts } from '../companies/CompanyPage';
import { centerInvoke,displayCenterContact,type CenterContactPort,type CenterInvoke } from './centerContactPort';
/** Adapts the original company UI, including empty companies; never calls legacy SQLite writes. */
export function createCenterCompanyPort(port:CenterContactPort,offline:boolean,invoke:CenterInvoke=centerInvoke):CompanyDataPort {
 const details=new Map<number,CenterCompanyDetail>(),patches=new Map<string,CenterCompanyUpdate>(),deletes=new Map<number,CompanyDelete>();
 let creation:{signature:string;request:CompanyCreate}|undefined;
 return {key:port.key,canCreate:!offline,
  async list(search,page,pageSize){
   if(offline){const r=await port.readAll({search});if(!r.success)return {success:false,error:r.error};const companies=new Map<number,CompanyWithCounts>();for(const row of r.data??[]){const old=companies.get(row.companyId);if(old)old.contactCount++;else companies.set(row.companyId,{id:row.companyId,name:row.companyName,domain:null,industry:null,country:null,size:null,contactCount:1,sentCount:null,repliedCount:null,createdAt:row.createdAt,updatedAt:row.updatedAt});}return {success:true,data:{items:[...companies.values()].slice((page-1)*pageSize,page*pageSize),total:companies.size}};}
   const result=await invoke<CenterCompanyPage>(ONLINE_CHANNELS.COMPANY_LIST,{search,scope:port.scope??'all',limit:pageSize,offset:(page-1)*pageSize} satisfies CompanyQuery);
   if(!port.isCurrent())return {success:false,error:'账号或权限已变化'};
   return result.ok?{success:true,data:{...result.data,items:result.data.items.map(co=>({...co,id:co.companyId,sentCount:null,repliedCount:null}))}}:{success:false,error:result.error.message};
  },
  async detail(id){
   if(offline){const r=await port.readAll();if(!r.success)return {success:false,error:r.error};const rows=(r.data??[]).filter(x=>x.companyId===id);const first=rows[0];if(!first)return {success:false,error:'公司尚未缓存'};const d=await invoke<CenterContactDetail>(ONLINE_CHANNELS.CONTACT_DETAIL,{contactId:first.contactId,customerId:first.customerId});if(!d.ok)return {success:false,error:d.error.message};return {success:true,data:{canEdit:false,canDelete:false,company:{id,name:d.data.company.name,domain:d.data.company.domain,customerType:d.data.company.customerType??null,industry:d.data.company.industry??null,country:d.data.company.country??null,size:d.data.company.size??null,createdAt:first.createdAt},contacts:rows.map(displayCenterContact),sentCount:null,repliedCount:null}};}
   const r=await invoke<CenterCompanyDetail>(ONLINE_CHANNELS.COMPANY_DETAIL,{companyId:id,scope:port.scope??'all'});
   if(!port.isCurrent())return {success:false,error:'账号或权限已变化'};if(!r.ok)return {success:false,error:r.error.message};details.set(id,r.data);
   const first=r.data.contacts[0];let canEdit=false;
   if(first){const d=await invoke<CenterContactDetail>(ONLINE_CHANNELS.CONTACT_DETAIL,{contactId:first.contactId,customerId:first.customerId});if(d.ok)canEdit=!!d.data.company.canEdit;}
   if(!port.isCurrent())return {success:false,error:'账号或权限已变化'};
   return {success:true,data:{canEdit,canDelete:r.data.company.canDelete,company:{...r.data.company,id},contacts:r.data.contacts.map(displayCenterContact),sentCount:null,repliedCount:null}};
  },
  async update(input){
   if(offline||!port.isCurrent())return {success:false,error:'请连接中心后重试'};
   if(input.id===undefined){const request={name:String(input.name??''),domain:typeof input.domain==='string'?input.domain:null};const signature=JSON.stringify(request);if(creation?.signature!==signature)creation={signature,request:{...request,idempotencyKey:crypto.randomUUID()}};const r=await invoke<CenterCompanyDetail>(ONLINE_CHANNELS.COMPANY_CREATE,creation.request);if(!port.isCurrent())return {success:false,error:'账号已切换'};if(!r.ok)return {success:false,error:r.error.message};creation=undefined;return {success:true,data:{id:r.data.company.companyId}};}
   const detail=details.get(Number(input.id)),first=detail?.contacts[0];if(!detail||!first)return {success:false,error:'请先添加联系人'};
   const fields=Object.fromEntries(['country','industry','size','customerType','domain'].filter(k=>k in input).map(k=>[k,input[k]]));const signature=JSON.stringify([input.id,fields]);let request=patches.get(signature);if(!request){request={contactId:first.contactId,customerId:first.customerId,expectedRevision:detail.company.revision,idempotencyKey:crypto.randomUUID(),fields};patches.set(signature,request);}
   const r=await invoke<CenterContactDetail>(ONLINE_CHANNELS.COMPANY_UPDATE,request);if(!port.isCurrent())return {success:false,error:'账号已切换'};if(!r.ok){if(r.error.code==='CONFLICT')patches.delete(signature);return {success:false,error:r.error.message};}patches.delete(signature);return {success:true};
  },
  async delete(id){
   const detail=details.get(id);if(offline||!port.isCurrent()||!detail?.company.canDelete)return {success:false,error:'公司有关联资料或无删除权限'};
   let request=deletes.get(id);if(!request){request={companyId:id,expectedRevision:detail.company.revision,idempotencyKey:crypto.randomUUID()};deletes.set(id,request);}
   const r=await invoke<{companyId:number}>(ONLINE_CHANNELS.COMPANY_DELETE,request);if(!port.isCurrent())return {success:false,error:'账号已切换'};if(!r.ok){if(r.error.code==='CONFLICT')deletes.delete(id);return {success:false,error:r.error.message};}details.delete(id);deletes.delete(id);return {success:true};
  },
 };
}
