import type { ImportFileContent } from "../../shared/online-crm";
import type { AccountProfile, Result, Identity, OnlineLogin, ImportPreview, ImportRequest, ImportReceipt, PublishRequest, PublishReceipt, LeadBootstrap, LeadQuery, LeadPage, LeadDetail, LeadCommand, FollowupRequest, OnlineFeed, NotificationReadAllReceipt } from '../../shared/online-crm';
import type { OnlineSessionSnapshot, OnlinePasswordChange, OnlineRegistration, RegisteredAccount, OnlineFeedRequest } from '../../shared/online-crm';
import type { LoginAccountQuery, SavedAccountLogin, OnlineLogout } from '../../shared/online-crm';
import type { CustomerCreate, CustomerUpdate, MemberQuery, MemberPage } from '../../shared/online-crm';
import { LEAD_ROUTES } from '../../../server/core/leads';
import { failure } from '../../../server/core/crm';
import {centerContactQuery,centerContactPath,type CenterContactPage,type CenterContactQuery} from '../../../server/core/center-contacts';
import { WORKBOOK_IMPORT_ROUTE, type WorkbookImportRequest, type WorkbookImportReceipt } from '../../../server/core/customer-import';
import type { FollowupTask, TaskQuery, TaskPage, TaskCreate, TaskReschedule, TaskComplete } from '../../../server/core/tasks';
import { OPPORTUNITY_ROUTES, type Opportunity, type OpportunityPage, type OpportunityQuery, type OpportunityCreate, type OpportunityUpdateStage } from '../../../server/core/opportunities';
import { NOTIFICATION_ROUTES } from '../../../server/core/notifications';
import { CONTACT_ASSIGNMENT_ROUTES, type CenterCompanyUpdate,type CenterContactRef, type CenterContactDetail, type CenterContactUpdate, type CenterContactFollowup, type ContactAssignmentQuery, type ContactAssignmentPage, type ContactAssignmentCreate, type ContactAssignmentReceipt, type ContactAssignmentDecision, type ContactAssignment } from '../../../server/core/contact-assignments';
import {companyUpdate,contactRef,contactUpdate,contactFollowup,contactAssignmentQuery,contactAssignmentCreate,contactAssignmentDecision} from '../../../server/services/contact-assignments';
import {companyCreate,companyDelete,companyQuery,companyRef,contactDelete} from '../../../server/services/crm-lifecycle';
import {COMPANY_ROUTE,CONTACT_DELETE_ROUTE,type CompanyCreate,type CompanyDelete,type CompanyQuery,type CompanyPage,type CompanyDetail,type ContactDelete,type ContactDeleteReceipt} from '../../../server/core/crm-lifecycle';
import { CONTACT_SHARING_ROUTES, type ContactShare, type ContactSharePage, type ContactShareQuery, type ContactShareCreate, type ContactShareUpdate, type ContactShareMember } from '../../../server/core/contact-sharing';
import type { ContactShareDecisionInput } from '../../shared/online-crm';
import { contactShareQuery, contactShareCreate, contactShareDecision, contactShareUpdate } from '../../../server/services/contact-sharing';
/** IO port is implemented by the adapter; this service never touches the local CRM. */
export interface OnlineCrmPort {
  contactDetail?(reference:CenterContactRef):Promise<Result<CenterContactDetail>>;
  contactUpdate?(input:CenterContactUpdate):Promise<Result<CenterContactDetail>>;
  contactFollowup?(input:CenterContactFollowup):Promise<Result<CenterContactDetail>>;
  contacts?(query:CenterContactQuery):Promise<Result<CenterContactPage>>;
  register?(input:OnlineRegistration):Promise<Result<RegisteredAccount>>;
  login(input:OnlineLogin):Promise<Result<Identity>>; logout(input?:OnlineLogout):Promise<Result<void>>;
  accountProfile?():Promise<Result<AccountProfile>>;
  request<T>(method:string,path:string,body?:unknown,requireCenterReceipt?:boolean):Promise<Result<T>>;
  preview(input?:ImportFileContent):Promise<Result<ImportPreview>>; feed(input?:OnlineFeedRequest):Promise<Result<OnlineFeed>>;
  workbookPreview?():Promise<Result<ImportPreview>>;
  status?():Promise<Result<OnlineSessionSnapshot>>; restore?():Promise<Result<OnlineSessionSnapshot>>;
  accounts?():Promise<Result<LoginAccountQuery>>;
  loginAccount?(input:SavedAccountLogin):Promise<Result<OnlineSessionSnapshot>>;
  removeAccount?(accountId:string):Promise<Result<void>>;
  changePassword?(input:OnlinePasswordChange):Promise<Result<void>>;
  tasks?(query:TaskQuery):Promise<Result<TaskPage>>;
  createTask?(input:TaskCreate):Promise<Result<FollowupTask>>;
  rescheduleTask?(input:TaskReschedule):Promise<Result<FollowupTask>>;
  completeTask?(input:TaskComplete):Promise<Result<FollowupTask>>;
}
export function createOnlineCrmService(port:OnlineCrmPort) {
  const validated = <I,T>(input:unknown,parse:(value:unknown)=>Result<I>,send:(value:I)=>Promise<Result<T>>):Promise<Result<T>> => {
    const value=parse(input);return value.ok?send(value.data):Promise.resolve(value);
  };
  const decision=(action:'accept'|'reject'|'cancel',input:unknown)=>validated(input,contactAssignmentDecision,value=>port.request<ContactAssignment>('POST',`${CONTACT_ASSIGNMENT_ROUTES.assignments}/${encodeURIComponent(value.requestId)}/${action}`,value));
  return {
    contactShares:(input:ContactShareQuery)=>validated(input,contactShareQuery,query=>{
      const params=new URLSearchParams({view:query.view,limit:String(query.limit),offset:String(query.offset)});
      if(query.status)params.set('status',query.status);
      if(query.contactId)params.set('contactId',String(query.contactId));
      if(query.customerId)params.set('customerId',query.customerId);
      return port.request<ContactSharePage>('GET',`${CONTACT_SHARING_ROUTES.shares}?${params}`,undefined,true);
    }),
    createContactShare:(input:ContactShareCreate)=>validated(input,contactShareCreate,value=>port.request<ContactShare>('POST',CONTACT_SHARING_ROUTES.shares,value,true)),
    decideContactShare:(input:ContactShareDecisionInput)=>{
      if(!input||!['accept','reject','revoke'].includes(input.action))return Promise.resolve(failure('INVALID_INPUT','共享操作无效'));
      const {action,...decisionInput}=input;
      return validated(decisionInput,contactShareDecision,value=>port.request<ContactShare>('POST',`${CONTACT_SHARING_ROUTES.shares}/${encodeURIComponent(value.shareId)}/${action}`,value,true));
    },
    updateContactShare:(input:ContactShareUpdate)=>validated(input,contactShareUpdate,value=>port.request<ContactShare>('POST',`${CONTACT_SHARING_ROUTES.shares}/${encodeURIComponent(value.shareId)}/update`,value,true)),
    contactShareMembers:()=>port.request<ContactShareMember[]>('GET',CONTACT_SHARING_ROUTES.members,undefined,true),
    deleteContacts:(input:ContactDelete)=>validated(input,contactDelete,v=>port.request<ContactDeleteReceipt>('POST',CONTACT_DELETE_ROUTE,v,true)),
    createCompany:(input:CompanyCreate)=>validated(input,companyCreate,v=>port.request<CompanyDetail>('POST',COMPANY_ROUTE,v,true)),
    deleteCompany:(input:CompanyDelete)=>validated(input,companyDelete,v=>port.request<{companyId:number}>('POST',`${COMPANY_ROUTE}/${v.companyId}/delete`,v,true)),
    companies:(input:CompanyQuery)=>validated(input,companyQuery,v=>port.request<CompanyPage>('GET',`${COMPANY_ROUTE}?${new URLSearchParams({search:v.search,scope:v.scope,limit:String(v.limit),offset:String(v.offset)})}`,undefined,true)),
    companyDetail:(input:{companyId:number;scope:CompanyQuery['scope']})=>validated(input,companyRef,v=>port.request<CompanyDetail>('GET',`${COMPANY_ROUTE}/${v.companyId}?scope=${v.scope}`,undefined,true)),
    companyUpdate:(input:CenterCompanyUpdate)=>validated(input,companyUpdate,value=>port.request<CenterContactDetail>('POST',`${CONTACT_ASSIGNMENT_ROUTES.contact}/${encodeURIComponent(String(value.contactId))}/company`,value,true)),
    contactDetail:(input:CenterContactRef)=>validated(input,contactRef,value=>port.contactDetail?port.contactDetail(value):port.request<CenterContactDetail>('GET',`${CONTACT_ASSIGNMENT_ROUTES.contact}/${encodeURIComponent(String(value.contactId))}?customerId=${encodeURIComponent(value.customerId)}`)),
    contactUpdate:(input:CenterContactUpdate)=>validated(input,contactUpdate,value=>port.contactUpdate?port.contactUpdate(value):port.request<CenterContactDetail>('POST',`${CONTACT_ASSIGNMENT_ROUTES.contact}/${encodeURIComponent(String(value.contactId))}/update`,value,true)),
    contactFollowup:(input:CenterContactFollowup)=>validated(input,contactFollowup,value=>port.contactFollowup?port.contactFollowup(value):port.request<CenterContactDetail>('POST',`${CONTACT_ASSIGNMENT_ROUTES.contact}/${encodeURIComponent(String(value.contactId))}/followups`,value,true)),
    assignments:(input:ContactAssignmentQuery)=>validated(input,contactAssignmentQuery,query=>port.request<ContactAssignmentPage>('GET',`${CONTACT_ASSIGNMENT_ROUTES.assignments}?view=${encodeURIComponent(query.view)}&status=${encodeURIComponent(query.status)}&search=${encodeURIComponent(query.search)}&limit=${query.limit}&offset=${query.offset}${query.requestId?`&requestId=${encodeURIComponent(query.requestId)}`:''}`)),
    createAssignments:(input:ContactAssignmentCreate)=>validated(input,contactAssignmentCreate,value=>port.request<ContactAssignmentReceipt>('POST',CONTACT_ASSIGNMENT_ROUTES.assignments,value)),
    acceptAssignment:(input:ContactAssignmentDecision)=>decision('accept',input),
    rejectAssignment:(input:ContactAssignmentDecision)=>decision('reject',input),
    cancelAssignment:(input:ContactAssignmentDecision)=>decision('cancel',input),
    contacts:(input:unknown)=>{const query=centerContactQuery(input);return query.ok?(port.contacts?port.contacts(query.data):port.request<CenterContactPage>('GET',centerContactPath(query.data))):Promise.resolve(query);},
    opportunities:(query:OpportunityQuery)=>port.request<OpportunityPage>('GET',`${OPPORTUNITY_ROUTES.opportunities}?customerId=${encodeURIComponent(query.customerId)}&limit=${query.limit}&offset=${query.offset}`),
    createOpportunity:(input:OpportunityCreate)=>port.request<Opportunity>('POST',OPPORTUNITY_ROUTES.opportunities,input),
    opportunityDetail:(id:string)=>port.request<Opportunity>('GET',`${OPPORTUNITY_ROUTES.opportunities}/${encodeURIComponent(id)}`),
    opportunityStage:(input:OpportunityUpdateStage)=>port.request<Opportunity>('POST',`${OPPORTUNITY_ROUTES.opportunities}/${encodeURIComponent(input.opportunityId)}/${OPPORTUNITY_ROUTES.stageAction}`,input),
    register:(input:OnlineRegistration)=>port.register?.(input) ?? Promise.resolve(failure('UNAVAILABLE','注册暂不可用')),
    login:(input:OnlineLogin)=>port.login(input), logout:(input?:OnlineLogout)=>port.logout(input), preview:(input?:ImportFileContent)=>port.preview(input),
    accountProfile:()=>port.accountProfile?.() ?? Promise.resolve(failure('UNAVAILABLE','账号资料暂不可用')),
    workbookPreview:()=>port.workbookPreview?.() ?? Promise.resolve(failure('UNAVAILABLE','工作簿预览暂不可用')),
    importWorkbook:(input:WorkbookImportRequest)=>port.request<WorkbookImportReceipt>('POST',WORKBOOK_IMPORT_ROUTE,input),
    status:()=>port.status?.() ?? Promise.resolve(failure('UNAVAILABLE','身份状态不可用')),
    restore:()=>port.restore?.() ?? Promise.resolve(failure('UNAVAILABLE','登录恢复不可用')),
    accounts:()=>port.accounts?.() ?? Promise.resolve(failure('UNAVAILABLE','账号预设暂不可用')),
    loginAccount:(input:SavedAccountLogin)=>port.loginAccount?.(input) ?? Promise.resolve(failure('UNAVAILABLE','账号预设暂不可用')),
    removeAccount:(accountId:string)=>port.removeAccount?.(accountId) ?? Promise.resolve(failure('UNAVAILABLE','账号预设暂不可用')),
    changePassword:(input:OnlinePasswordChange)=>port.changePassword?.(input) ?? Promise.resolve(failure('UNAVAILABLE','改密不可用')),
    bootstrap:()=>port.request<LeadBootstrap>('GET','/api/crm/bootstrap'),
    importRows:(input:ImportRequest)=>port.request<ImportReceipt>('POST','/api/crm/imports',input,true),
    publish:(id:string,input:PublishRequest)=>port.request<PublishReceipt>('POST',`/api/crm/imports/${encodeURIComponent(id)}/publish`,input),
    list:(query:LeadQuery)=>port.request<LeadPage>('GET',`/api/crm/leads?view=${query.view}&search=${encodeURIComponent(query.search)}&limit=${query.limit}&offset=${query.offset}${query.assignment ? `&assignment=${encodeURIComponent(query.assignment)}` : ''}${query.stage ? `&stage=${encodeURIComponent(query.stage)}` : ''}${query.followupOnly !== undefined ? `&followupOnly=${query.followupOnly}` : ''}`),
    detail:(id:string)=>port.request<LeadDetail>('GET',`/api/crm/leads/${encodeURIComponent(id)}`),
    createCustomer:(input:CustomerCreate)=>port.request<LeadDetail>('POST','/api/crm/leads',input),
    updateCustomer:(input:CustomerUpdate)=>port.request<LeadDetail>('POST',`/api/crm/leads/${encodeURIComponent(input.customerId)}/update`,input),
    members:(query:MemberQuery)=>port.request<MemberPage>('GET',`${LEAD_ROUTES.members}?search=${encodeURIComponent(query.search)}&limit=${query.limit}&offset=${query.offset}`),
    followup:(input:FollowupRequest)=>port.request<LeadDetail>('POST',`/api/crm/leads/${encodeURIComponent(input.customerId)}/followups`,input),
    feed:(input?:OnlineFeedRequest)=>port.feed(input), read:(id:string)=>port.request<void>('POST',`/api/crm/notifications/${encodeURIComponent(id)}/read`,{}), readAll:()=>port.request<NotificationReadAllReceipt>('POST',NOTIFICATION_ROUTES.readAll,{}),
    tasks:(query:TaskQuery)=>port.tasks?.(query) ?? Promise.resolve(failure('UNAVAILABLE','任务服务不可用')),
    createTask:(input:TaskCreate)=>port.createTask?.(input) ?? Promise.resolve(failure('UNAVAILABLE','任务服务不可用')),
    rescheduleTask:(input:TaskReschedule)=>port.rescheduleTask?.(input) ?? Promise.resolve(failure('UNAVAILABLE','任务服务不可用')),
    completeTask:(input:TaskComplete)=>port.completeTask?.(input) ?? Promise.resolve(failure('UNAVAILABLE','任务服务不可用')),
  };
}
