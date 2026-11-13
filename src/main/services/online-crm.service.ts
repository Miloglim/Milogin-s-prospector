import type { ImportFileContent } from "../../shared/online-crm";
import type { AccountProfile, Result, Identity, OnlineLogin, ImportPreview, ImportRequest, ImportReceipt, PublishRequest, PublishReceipt, LeadBootstrap, LeadQuery, LeadPage, LeadDetail, LeadCommand, FollowupRequest, OnlineFeed, NotificationReadAllReceipt } from '../../shared/online-crm';
import type { OnlineSessionSnapshot, OnlinePasswordChange, OnlineRegistration, RegisteredAccount, OnlineFeedRequest, OnlineHandoffBegin, OnlineHandoffBeginResult, OnlineHandoffComplete, OnlineHandoffState, OnlineHandoffTakeover, OnlineHandoffToken } from '../../shared/online-crm';
import type { LoginAccountQuery, SavedAccountLogin, OnlineLogout, LeadIngressDecisionDTO, LeadIngressDecisionQuery, LeadIngressResolutionCommand, LeadIngressResolutionReceipt } from '../../shared/online-crm';
import { TEAM_ROUTES, type CustomerCreate, type CustomerUpdate, type MemberQuery, type MemberPage, type TeamContext, type TeamCreateInput, type TeamCreateReceipt, type TeamDetail, type TeamDissolveInput, type TeamInvitationDecision, type TeamInviteInput, type TeamLeaderInput, type TeamMemberAdjustmentInput, type TeamMemberCandidatePage, type TeamMemberCandidateQuery, type TeamMemberGroupDeleteInput, type TeamMemberGroupInput, type TeamMoveInput } from '../../shared/online-crm';
import { LEAD_ROUTES } from '../../../server/core/leads';
import { failure } from '../../../server/core/crm';
import {CENTER_CONTACT_GROUP_ROUTE,centerContactGroupQuery,centerContactQuery,centerContactPath,type CenterContactGroupPage,type CenterContactGroupQuery,type CenterContactPage,type CenterContactQuery} from '../../../server/core/center-contacts';
import { WORKBOOK_IMPORT_ROUTE, type WorkbookImportRequest, type WorkbookImportReceipt } from '../../../server/core/customer-import';
import type { FollowupTask, TaskQuery, TaskPage, TaskCreate, TaskReschedule, TaskComplete } from '../../../server/core/tasks';
import { TEAM_ATTENTION_ROUTES, type TeamAttentionCreate, type TeamAttentionItem, type TeamAttentionPage, type TeamAttentionQuery, type TeamAttentionTransitionAction } from '../../../server/core/team-attention';
import { TEAM_MONITORING_LIMITS, TEAM_MONITORING_ROUTES, type TeamMonitoringContactSummary, type TeamMonitoringMailDetail, type TeamMonitoringMemberDetail, type TeamMonitoringOverview, type TeamMonitoringQuery } from '../../../server/core/team-monitoring';
import { CUSTOMER_GRADES, SALES_PERFORMANCE_LIMITS, SALES_PERFORMANCE_ROUTES, SALES_PERFORMANCE_STRATA, type CustomerGradeOverrideClear, type CustomerGradeOverrideReceipt, type CustomerGradeOverrideSet, type CustomerGradePage, type CustomerGradeQuery, type SalesPerformanceOverview, type SalesPerformanceQuery } from '../../../server/core/sales-performance';
import { OPPORTUNITY_ROUTES, type Opportunity, type OpportunityPage, type OpportunityQuery, type OpportunityCreate, type OpportunityUpdateStage } from '../../../server/core/opportunities';
import { NOTIFICATION_ROUTES } from '../../../server/core/notifications';
import { CONTACT_ASSIGNMENT_ROUTES, type CenterCompanyUpdate,type CenterContactRef, type CenterContactDetail, type CenterContactUpdate, type CenterContactFollowup, type ContactAssignmentQuery, type ContactAssignmentPage, type ContactAssignmentGroupQuery, type ContactAssignmentGroupPage, type ContactAssignmentGroupDecision, type ContactAssignmentCreate, type ContactAssignmentReceipt, type ContactAssignmentDecision, type ContactAssignment, type ContactAssignmentTransfer, type ContactAssignmentExpiryInput, type ContactAssignmentExpiryReceipt, type ContactMonitorDetail } from '../../../server/core/contact-assignments';
import {companyUpdate,contactRef,contactUpdate,contactFollowup,contactAssignmentQuery,contactAssignmentGroupQuery,contactAssignmentGroupDecision,contactAssignmentCreate,contactAssignmentDecision,contactAssignmentTransfer,contactAssignmentExpiry} from '../../../server/services/contact-assignments';
import {companyCreate,companyDelete,companyQuery,companyRef,contactDelete} from '../../../server/services/crm-lifecycle';
import {COMPANY_ROUTE,CONTACT_DELETE_ROUTE,type CompanyCreate,type CompanyDelete,type CompanyQuery,type CompanyPage,type CompanyDetail,type ContactDelete,type ContactDeleteReceipt} from '../../../server/core/crm-lifecycle';
import { CONTACT_SHARING_ROUTES, type ContactShare, type ContactSharePage, type ContactShareQuery, type ContactShareCreate, type ContactShareUpdate, type ContactShareMember, type ContactTeamShareCreate, type ContactTeamShareReceipt } from '../../../server/core/contact-sharing';
import type { ContactShareDecisionInput } from '../../shared/online-crm';
import { contactShareQuery, contactShareCreate, contactShareDecision, contactShareUpdate, contactTeamShareCreate } from '../../../server/services/contact-sharing';
import { LEAD_INGRESS_ROUTES, validateLeadIngressDecisionQuery, validateLeadIngressResolution } from '../../../server/core/lead-ingress';
import type { ContactMailAnalysisCorrection, ContactMailAnalysisQuery, ContactMailAnalysisRecord, ContactMailAnalysisSubmission, ContactMailAnalysisView } from '../../../server/core/mail-analysis';
import { CONTACT_MAIL_ANALYSIS_ROUTES } from '../../../server/core/mail-analysis';
import { contactMailAnalysisCorrection, contactMailAnalysisQuery, contactMailAnalysisSubmission } from '../../../server/services/contact-mail-analysis';
import { Log } from '../logger';
const MONITORING_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/** IO port is implemented by the adapter; this service never touches the local CRM. */
export interface OnlineCrmPort {
  requestLive?<T>(method:string,path:string,body?:unknown):Promise<Result<T>>;
  contactDetail?(reference:CenterContactRef):Promise<Result<CenterContactDetail>>;
  contactMonitorDetail?(reference:CenterContactRef):Promise<Result<ContactMonitorDetail>>;
  contactUpdate?(input:CenterContactUpdate):Promise<Result<CenterContactDetail>>;
  contactFollowup?(input:CenterContactFollowup):Promise<Result<CenterContactDetail>>;
  leadIngressDecision?(input:LeadIngressDecisionQuery):Promise<Result<LeadIngressDecisionDTO>>;
  resolveLeadIngress?(input:LeadIngressResolutionCommand):Promise<Result<LeadIngressResolutionReceipt>>;
  contacts?(query:CenterContactQuery):Promise<Result<CenterContactPage>>;
  contactGroups?(query:CenterContactGroupQuery):Promise<Result<CenterContactGroupPage>>;
  register?(input:OnlineRegistration):Promise<Result<RegisteredAccount>>;
  login(input:OnlineLogin):Promise<Result<Identity>>; logout(input?:OnlineLogout):Promise<Result<void>>;
  beginHandoff?(input:OnlineHandoffBegin):Promise<Result<OnlineHandoffBeginResult>>;
  handoffStatus?(input:OnlineHandoffToken):Promise<Result<OnlineHandoffState>>;
  completeHandoff?(input:OnlineHandoffComplete):Promise<Result<Identity>>;
  takeoverHandoff?(input:OnlineHandoffTakeover):Promise<Result<Identity>>;
  cancelHandoff?(input:OnlineHandoffToken):Promise<Result<void>>;
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
  teamAttention?(query:TeamAttentionQuery):Promise<Result<TeamAttentionPage>>;
  createTeamAttention?(input:TeamAttentionCreate):Promise<Result<TeamAttentionItem>>;
  transitionTeamAttention?(itemId:string,action:TeamAttentionTransitionAction,input:Omit<import('../../../server/core/team-attention').TeamAttentionTransition,'itemId'|'action'>):Promise<Result<TeamAttentionItem>>;
  teamMonitoring?(query:TeamMonitoringQuery):Promise<Result<TeamMonitoringOverview>>;
  teamMonitoringMember?(userId:string,limit:number,offset:number):Promise<Result<TeamMonitoringMemberDetail>>;
  teamMonitoringContact?(contactId:number,customerId:string,limit:number,offset:number):Promise<Result<TeamMonitoringContactSummary>>;
  teamMonitoringMail?(eventId:string,contactId:number,customerId:string):Promise<Result<TeamMonitoringMailDetail>>;
  salesPerformance?(query:SalesPerformanceQuery):Promise<Result<SalesPerformanceOverview>>;
  salesPerformanceGrades?(query:CustomerGradeQuery):Promise<Result<CustomerGradePage>>;
  setSalesPerformanceGrade?(input:CustomerGradeOverrideSet):Promise<Result<CustomerGradeOverrideReceipt>>;
  clearSalesPerformanceGrade?(input:CustomerGradeOverrideClear):Promise<Result<CustomerGradeOverrideReceipt>>;
  contactMailAnalysis?(query:ContactMailAnalysisQuery):Promise<Result<ContactMailAnalysisView>>;
  submitContactMailAnalysis?(input:ContactMailAnalysisSubmission):Promise<Result<ContactMailAnalysisRecord>>;
  correctContactMailAnalysis?(input:ContactMailAnalysisCorrection):Promise<Result<ContactMailAnalysisRecord>>;
  teamMove?(teamId:string,input:TeamMoveInput):Promise<Result<TeamContext>>;
  teamDissolve?(teamId:string,input:TeamDissolveInput):Promise<Result<TeamContext>>;
  teamAssignLeader?(teamId:string,input:TeamLeaderInput):Promise<Result<TeamContext>>;
  teamAdjustMember?(teamId:string,input:TeamMemberAdjustmentInput):Promise<Result<TeamContext>>;
  teamSaveMemberGroup?(teamId:string,input:TeamMemberGroupInput):Promise<Result<TeamContext>>;
  teamDeleteMemberGroup?(teamId:string,groupId:string,input:TeamMemberGroupDeleteInput):Promise<Result<TeamContext>>;
}
export function createOnlineCrmService(port:OnlineCrmPort) {
  const validated = <I,T>(input:unknown,parse:(value:unknown)=>Result<I>,send:(value:I)=>Promise<Result<T>>):Promise<Result<T>> => {
    const value=parse(input);return value.ok?send(value.data):Promise.resolve(value);
  };
  const live = <T>(method:string,path:string,body?:unknown):Promise<Result<T>> => port.requestLive?.(method,path,body) ?? port.request<T>(method,path,body,true);
  const monitoringPage = (limit:number,offset:number):boolean => Number.isSafeInteger(limit) && limit>=1 && limit<=TEAM_MONITORING_LIMITS.pageMax && Number.isSafeInteger(offset) && offset>=0;
  const salesPage = (limit:number,offset:number):boolean => Number.isSafeInteger(limit) && limit>=1 && limit<=SALES_PERFORMANCE_LIMITS.pageMax && Number.isSafeInteger(offset) && offset>=0;
  const salesWindow = (from:string,to:string):boolean => typeof from==='string' && typeof to==='string' && Number.isFinite(Date.parse(from)) && Number.isFinite(Date.parse(to)) && Date.parse(from)<Date.parse(to);
  const salesUuid = (value:string|undefined):boolean => value===undefined || MONITORING_UUID.test(value);
  const decision=(action:'accept'|'reject'|'cancel',input:unknown)=>validated(input,contactAssignmentDecision,value=>port.request<ContactAssignment>('POST',`${CONTACT_ASSIGNMENT_ROUTES.assignments}/${encodeURIComponent(value.requestId)}/${action}`,value));
  const groupDecision=(action:'accept'|'reject'|'cancel',input:unknown)=>validated(input,contactAssignmentGroupDecision,value=>port.request<ContactAssignmentReceipt>('POST',`${CONTACT_ASSIGNMENT_ROUTES.groups}/${encodeURIComponent(value.groupId)}/${action}`,value));
  return {
    contactShares:(input:ContactShareQuery)=>validated(input,contactShareQuery,query=>{
      const params=new URLSearchParams({view:query.view,limit:String(query.limit),offset:String(query.offset)});
      if(query.status)params.set('status',query.status);
      if(query.contactId)params.set('contactId',String(query.contactId));
      if(query.customerId)params.set('customerId',query.customerId);
      return port.request<ContactSharePage>('GET',`${CONTACT_SHARING_ROUTES.shares}?${params}`,undefined,true);
    }),
    createContactShare:(input:ContactShareCreate)=>validated(input,contactShareCreate,value=>port.request<ContactShare>('POST',CONTACT_SHARING_ROUTES.shares,value,true)),
    shareContactWithTeam:(input:ContactTeamShareCreate)=>validated(input,contactTeamShareCreate,value=>port.request<ContactTeamShareReceipt>('POST',CONTACT_SHARING_ROUTES.team,value,true)),
    decideContactShare:(input:ContactShareDecisionInput)=>{
      if(!input||!['accept','reject','revoke'].includes(input.action))return Promise.resolve(failure('INVALID_INPUT','共享操作无效'));
      const {action,...decisionInput}=input;
      return validated(decisionInput,contactShareDecision,value=>port.request<ContactShare>('POST',`${CONTACT_SHARING_ROUTES.shares}/${encodeURIComponent(value.shareId)}/${action}`,value,true));
    },
    updateContactShare:(input:ContactShareUpdate)=>validated(input,contactShareUpdate,value=>port.request<ContactShare>('POST',`${CONTACT_SHARING_ROUTES.shares}/${encodeURIComponent(value.shareId)}/update`,value,true)),
    contactShareMembers:()=>port.request<ContactShareMember[]>('GET',CONTACT_SHARING_ROUTES.members,undefined,true),
    deleteContacts:(input:ContactDelete)=>validated(input,contactDelete,async v=>{
      Log.debug('online.contacts.delete',`向中心发送删除请求 ${v.contacts.length} 个联系人`);
      const result=await port.request<ContactDeleteReceipt>('POST',CONTACT_DELETE_ROUTE,v,true);
      if(result.ok)Log.debug('online.contacts.delete',`中心删除回执完成 ${result.data.deleted.length} 个联系人`);
      else Log.warn('online.contacts.delete',`中心删除失败 ${result.error.code}: ${result.error.message}`);
      return result;
    }),
    createCompany:(input:CompanyCreate)=>validated(input,companyCreate,v=>port.request<CompanyDetail>('POST',COMPANY_ROUTE,v,true)),
    deleteCompany:(input:CompanyDelete)=>validated(input,companyDelete,v=>port.request<{companyId:number}>('POST',`${COMPANY_ROUTE}/${v.companyId}/delete`,v,true)),
    companies:(input:CompanyQuery)=>validated(input,companyQuery,v=>port.request<CompanyPage>('GET',`${COMPANY_ROUTE}?${new URLSearchParams({search:v.search,scope:v.scope,limit:String(v.limit),offset:String(v.offset)})}`,undefined,true)),
    companyDetail:(input:{companyId:number;scope:CompanyQuery['scope']})=>validated(input,companyRef,v=>port.request<CompanyDetail>('GET',`${COMPANY_ROUTE}/${v.companyId}?scope=${v.scope}`,undefined,true)),
    companyUpdate:(input:CenterCompanyUpdate)=>validated(input,companyUpdate,value=>port.request<CenterContactDetail>('POST',`${CONTACT_ASSIGNMENT_ROUTES.contact}/${encodeURIComponent(String(value.contactId))}/company`,value,true)),
    contactDetail:(input:CenterContactRef)=>validated(input,contactRef,value=>port.contactDetail?port.contactDetail(value):port.request<CenterContactDetail>('GET',`${CONTACT_ASSIGNMENT_ROUTES.contact}/${encodeURIComponent(String(value.contactId))}?customerId=${encodeURIComponent(value.customerId)}`)),
    contactMonitorDetail:(input:CenterContactRef)=>validated(input,contactRef,value=>port.contactMonitorDetail?port.contactMonitorDetail(value):port.request<ContactMonitorDetail>('GET',`${CONTACT_ASSIGNMENT_ROUTES.monitor}/${encodeURIComponent(String(value.contactId))}?customerId=${encodeURIComponent(value.customerId)}`)),
    contactUpdate:(input:CenterContactUpdate)=>validated(input,contactUpdate,value=>port.contactUpdate?port.contactUpdate(value):port.request<CenterContactDetail>('POST',`${CONTACT_ASSIGNMENT_ROUTES.contact}/${encodeURIComponent(String(value.contactId))}/update`,value,true)),
    contactFollowup:(input:CenterContactFollowup)=>validated(input,contactFollowup,value=>port.contactFollowup?port.contactFollowup(value):port.request<CenterContactDetail>('POST',`${CONTACT_ASSIGNMENT_ROUTES.contact}/${encodeURIComponent(String(value.contactId))}/followups`,value,true)),
    assignments:(input:ContactAssignmentQuery)=>validated(input,contactAssignmentQuery,query=>port.request<ContactAssignmentPage>('GET',`${CONTACT_ASSIGNMENT_ROUTES.assignments}?view=${encodeURIComponent(query.view)}&status=${encodeURIComponent(query.status)}&search=${encodeURIComponent(query.search)}&limit=${query.limit}&offset=${query.offset}${query.requestId?`&requestId=${encodeURIComponent(query.requestId)}`:''}${query.groupId?`&groupId=${encodeURIComponent(query.groupId)}`:''}`)),
    assignmentGroups:(input:ContactAssignmentGroupQuery)=>validated(input,contactAssignmentGroupQuery,query=>port.request<ContactAssignmentGroupPage>('GET',`${CONTACT_ASSIGNMENT_ROUTES.groups}?${new URLSearchParams({view:query.view,status:query.status,search:query.search,limit:String(query.limit),offset:String(query.offset)})}`)),
    createAssignments:(input:ContactAssignmentCreate)=>validated(input,contactAssignmentCreate,value=>port.request<ContactAssignmentReceipt>('POST',CONTACT_ASSIGNMENT_ROUTES.assignments,value)),
    acceptAssignment:(input:ContactAssignmentDecision)=>decision('accept',input),
    rejectAssignment:(input:ContactAssignmentDecision)=>decision('reject',input),
    cancelAssignment:(input:ContactAssignmentDecision)=>decision('cancel',input),
    transferAssignment:(input:ContactAssignmentTransfer)=>validated(input,contactAssignmentTransfer,value=>port.request<ContactAssignment>('POST',`${CONTACT_ASSIGNMENT_ROUTES.assignments}/${encodeURIComponent(value.requestId)}/transfer`,value)),
    expireAssignments:(input:ContactAssignmentExpiryInput)=>validated(input,contactAssignmentExpiry,value=>port.request<ContactAssignmentExpiryReceipt>('POST',CONTACT_ASSIGNMENT_ROUTES.expire,value)),
    acceptAssignmentGroup:(input:ContactAssignmentGroupDecision)=>groupDecision('accept',input),
    rejectAssignmentGroup:(input:ContactAssignmentGroupDecision)=>groupDecision('reject',input),
    cancelAssignmentGroup:(input:ContactAssignmentGroupDecision)=>groupDecision('cancel',input),
    contacts:(input:unknown)=>{const query=centerContactQuery(input);return query.ok?(port.contacts?port.contacts(query.data):port.request<CenterContactPage>('GET',centerContactPath(query.data))):Promise.resolve(query);},
    contactGroups:(input:unknown)=>{const query=centerContactGroupQuery(input);return query.ok?(port.contactGroups?port.contactGroups(query.data):port.request<CenterContactGroupPage>('GET',`${CENTER_CONTACT_GROUP_ROUTE}?${new URLSearchParams({dimension:query.data.dimension,scope:query.data.scope,search:query.data.search,limit:String(query.data.limit),offset:String(query.data.offset)})}`)):Promise.resolve(query);},
    opportunities:(query:OpportunityQuery)=>port.request<OpportunityPage>('GET',`${OPPORTUNITY_ROUTES.opportunities}?customerId=${encodeURIComponent(query.customerId)}&limit=${query.limit}&offset=${query.offset}`),
    createOpportunity:(input:OpportunityCreate)=>port.request<Opportunity>('POST',OPPORTUNITY_ROUTES.opportunities,input),
    opportunityDetail:(id:string)=>port.request<Opportunity>('GET',`${OPPORTUNITY_ROUTES.opportunities}/${encodeURIComponent(id)}`),
    opportunityStage:(input:OpportunityUpdateStage)=>port.request<Opportunity>('POST',`${OPPORTUNITY_ROUTES.opportunities}/${encodeURIComponent(input.opportunityId)}/${OPPORTUNITY_ROUTES.stageAction}`,input),
    teamContext:()=>port.request<TeamContext>('GET',TEAM_ROUTES.context),
    teamDetail:(teamId:string)=>port.request<TeamDetail>('GET',`${TEAM_ROUTES.teams}/${encodeURIComponent(teamId)}`),
    teamCandidates:(query:TeamMemberCandidateQuery)=>{
      const search=new URLSearchParams({search:query.search,limit:String(query.limit),offset:String(query.offset),role:query.role??'member',unitType:query.unitType??'sales_team'});
      if(query.purpose==='create')search.set('purpose','create');
      return port.request<TeamMemberCandidatePage>('GET',`${TEAM_ROUTES.candidates}?${search}`);
    },
    teamCreate:(input:TeamCreateInput)=>port.request<TeamCreateReceipt>('POST',TEAM_ROUTES.teams,input),
    teamInvite:(teamId:string,input:TeamInviteInput)=>port.request<TeamContext>('POST',`${TEAM_ROUTES.teams}/${encodeURIComponent(teamId)}/invitations`,input),
    teamInvitation:(invitationId:string,action:'accept'|'decline'|'cancel',input:TeamInvitationDecision)=>port.request<TeamContext>('POST',`${TEAM_ROUTES.invitations}/${encodeURIComponent(invitationId)}/${action}`,input),
    teamMove:(teamId:string,input:TeamMoveInput)=>port.teamMove?.(teamId,input) ?? port.request<TeamContext>('POST',`${TEAM_ROUTES.teams}/${encodeURIComponent(teamId)}/move`,input),
    teamDissolve:(teamId:string,input:TeamDissolveInput)=>port.teamDissolve?.(teamId,input) ?? port.request<TeamContext>('POST',`${TEAM_ROUTES.teams}/${encodeURIComponent(teamId)}/dissolve`,input),
    teamAssignLeader:(teamId:string,input:TeamLeaderInput)=>port.teamAssignLeader?.(teamId,input) ?? port.request<TeamContext>('POST',`${TEAM_ROUTES.teams}/${encodeURIComponent(teamId)}/leader`,input),
    teamAdjustMember:(teamId:string,input:TeamMemberAdjustmentInput)=>port.teamAdjustMember?.(teamId,input) ?? port.request<TeamContext>('POST',`${TEAM_ROUTES.teams}/${encodeURIComponent(teamId)}/members`,input),
    teamSaveMemberGroup:(teamId:string,input:TeamMemberGroupInput)=>port.teamSaveMemberGroup?.(teamId,input) ?? port.request<TeamContext>('POST',`${TEAM_ROUTES.teams}/${encodeURIComponent(teamId)}/groups`,input),
    teamDeleteMemberGroup:(teamId:string,groupId:string,input:TeamMemberGroupDeleteInput)=>port.teamDeleteMemberGroup?.(teamId,groupId,input) ?? port.request<TeamContext>('POST',`${TEAM_ROUTES.teams}/${encodeURIComponent(teamId)}/groups/${encodeURIComponent(groupId)}/delete`,input),
    register:(input:OnlineRegistration)=>port.register?.(input) ?? Promise.resolve(failure('UNAVAILABLE','注册暂不可用')),
    login:(input:OnlineLogin)=>port.login(input), logout:(input?:OnlineLogout)=>port.logout(input), preview:(input?:ImportFileContent)=>port.preview(input),
    beginHandoff:(input:OnlineHandoffBegin)=>port.beginHandoff?.(input) ?? Promise.resolve(failure('UNAVAILABLE','换机暂不可用')),
    handoffStatus:(input:OnlineHandoffToken)=>port.handoffStatus?.(input) ?? Promise.resolve(failure('UNAVAILABLE','换机状态暂不可用')),
    completeHandoff:(input:OnlineHandoffComplete)=>port.completeHandoff?.(input) ?? Promise.resolve(failure('UNAVAILABLE','换机完成暂不可用')),
    takeoverHandoff:(input:OnlineHandoffTakeover)=>port.takeoverHandoff?.(input) ?? Promise.resolve(failure('UNAVAILABLE','旧电脑接管暂不可用')),
    cancelHandoff:(input:OnlineHandoffToken)=>port.cancelHandoff?.(input) ?? Promise.resolve(failure('UNAVAILABLE','取消换机暂不可用')),
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
    leadIngressDecision:(input:LeadIngressDecisionQuery)=>{const parsed=validateLeadIngressDecisionQuery(input?.source,input?.idempotencyKey);if(!parsed.ok)return Promise.resolve(parsed);return port.leadIngressDecision?.(parsed.data)??port.request<LeadIngressDecisionDTO>('GET',`${LEAD_INGRESS_ROUTES.decision}?source=${encodeURIComponent(parsed.data.source)}&idempotencyKey=${encodeURIComponent(parsed.data.idempotencyKey)}`);},
    resolveLeadIngress:(input:LeadIngressResolutionCommand)=>{const parsed=validateLeadIngressResolution(input);if(!parsed.ok)return Promise.resolve(parsed);return port.resolveLeadIngress?.(parsed.data)??port.request<LeadIngressResolutionReceipt>('POST',LEAD_INGRESS_ROUTES.resolve,parsed.data);},
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
    teamAttention:(query:TeamAttentionQuery)=>port.teamAttention?.(query) ?? port.request<TeamAttentionPage>('GET',`${TEAM_ATTENTION_ROUTES.items}?${new URLSearchParams({limit:String(query.limit),offset:String(query.offset),...(query.status?{status:query.status}:{}),...(query.reason?{reason:query.reason}:{}),...(query.targetMemberUserId?{targetMemberUserId:query.targetMemberUserId}:{})})}`),
    createTeamAttention:(input:TeamAttentionCreate)=>port.createTeamAttention?.(input) ?? port.request<TeamAttentionItem>('POST',TEAM_ATTENTION_ROUTES.items,input,true),
    acknowledgeTeamAttention:(itemId:string,input:Omit<import('../../../server/core/team-attention').TeamAttentionTransition,'itemId'|'action'>)=>port.transitionTeamAttention?.(itemId,'acknowledge',input) ?? port.request<TeamAttentionItem>('POST',`${TEAM_ATTENTION_ROUTES.items}/${encodeURIComponent(itemId)}/acknowledge`,input,true),
    dismissTeamAttention:(itemId:string,input:Omit<import('../../../server/core/team-attention').TeamAttentionTransition,'itemId'|'action'>)=>port.transitionTeamAttention?.(itemId,'dismiss',input) ?? port.request<TeamAttentionItem>('POST',`${TEAM_ATTENTION_ROUTES.items}/${encodeURIComponent(itemId)}/dismiss`,input,true),
    resolveTeamAttention:(itemId:string,input:Omit<import('../../../server/core/team-attention').TeamAttentionTransition,'itemId'|'action'>)=>port.transitionTeamAttention?.(itemId,'resolve',input) ?? port.request<TeamAttentionItem>('POST',`${TEAM_ATTENTION_ROUTES.items}/${encodeURIComponent(itemId)}/resolve`,input,true),
    contactMailAnalysis:(input:ContactMailAnalysisQuery)=>validated(input,contactMailAnalysisQuery,query=>port.contactMailAnalysis?.(query)??port.request<ContactMailAnalysisView>('GET',`${CONTACT_MAIL_ANALYSIS_ROUTES.analyses}?${new URLSearchParams({contactId:String(query.contactId),customerId:query.customerId,mailboxKey:query.mailboxKey,messageKey:query.messageKey,contentHash:query.contentHash,history:String(query.includeHistory),limit:String(query.historyLimit)})}`)),
    submitContactMailAnalysis:(input:ContactMailAnalysisSubmission)=>validated(input,contactMailAnalysisSubmission,submission=>port.submitContactMailAnalysis?.(submission)??port.request<ContactMailAnalysisRecord>('POST',CONTACT_MAIL_ANALYSIS_ROUTES.ai,submission,true)),
    correctContactMailAnalysis:(input:ContactMailAnalysisCorrection)=>validated(input,contactMailAnalysisCorrection,correction=>port.correctContactMailAnalysis?.(correction)??port.request<ContactMailAnalysisRecord>('POST',CONTACT_MAIL_ANALYSIS_ROUTES.correct,correction,true)),
    teamMonitoring:(query:TeamMonitoringQuery)=>{
      if(!query||!monitoringPage(query.limit,query.offset)||!monitoringPage(query.unitLimit,query.unitOffset)||query.teamId!==undefined&&!MONITORING_UUID.test(query.teamId)||query.memberUserId!==undefined&&!MONITORING_UUID.test(query.memberUserId))return Promise.resolve(failure('INVALID_INPUT','团队监控查询参数无效'));
      if(port.teamMonitoring)return port.teamMonitoring(query);
      const params=new URLSearchParams({limit:String(query.limit),offset:String(query.offset),unitLimit:String(query.unitLimit),unitOffset:String(query.unitOffset)});
      if(query.teamId)params.set('teamId',query.teamId);if(query.memberUserId)params.set('memberUserId',query.memberUserId);
      return live<TeamMonitoringOverview>('GET',`${TEAM_MONITORING_ROUTES.overview}?${params}`);
    },
    teamMonitoringMember:(userId:string,limit:number,offset:number)=>{
      if(!MONITORING_UUID.test(userId)||!monitoringPage(limit,offset))return Promise.resolve(failure('INVALID_INPUT','成员监控查询参数无效'));
      return port.teamMonitoringMember?.(userId,limit,offset)??live<TeamMonitoringMemberDetail>('GET',`${TEAM_MONITORING_ROUTES.members}/${encodeURIComponent(userId)}?${new URLSearchParams({limit:String(limit),offset:String(offset)})}`);
    },
    teamMonitoringContact:(contactId:number,customerId:string,limit:number,offset:number)=>{
      if(!Number.isSafeInteger(contactId)||contactId<1||!MONITORING_UUID.test(customerId)||!monitoringPage(limit,offset))return Promise.resolve(failure('INVALID_INPUT','联系人监控查询参数无效'));
      return port.teamMonitoringContact?.(contactId,customerId,limit,offset)??live<TeamMonitoringContactSummary>('GET',`${TEAM_MONITORING_ROUTES.contacts}/${contactId}?${new URLSearchParams({customerId,limit:String(limit),offset:String(offset)})}`);
    },
    teamMonitoringMail:(eventId:string,contactId:number,customerId:string)=>{
      if(!MONITORING_UUID.test(eventId)||!Number.isSafeInteger(contactId)||contactId<1||!MONITORING_UUID.test(customerId))return Promise.resolve(failure('INVALID_INPUT','邮件监控查询参数无效'));
      return port.teamMonitoringMail?.(eventId,contactId,customerId)??live<TeamMonitoringMailDetail>('GET',`${TEAM_MONITORING_ROUTES.mail}/${encodeURIComponent(eventId)}?${new URLSearchParams({contactId:String(contactId),customerId})}`);
    },
    salesPerformance:(query:SalesPerformanceQuery)=>{
      if(!query||!salesWindow(query.from,query.to)||!SALES_PERFORMANCE_STRATA.includes(query.groupBy)||!salesUuid(query.teamId)||!salesUuid(query.memberUserId)||!salesUuid(query.batchId)||!salesPage(query.limit,query.offset))return Promise.resolve(failure('INVALID_INPUT','销售绩效查询参数无效'));
      if(port.salesPerformance)return port.salesPerformance(query);
      const params=new URLSearchParams({from:query.from,to:query.to,groupBy:query.groupBy,limit:String(query.limit),offset:String(query.offset)});
      for(const key of ['teamId','memberUserId','source','batchId','country'] as const)if(query[key])params.set(key,query[key]!);
      return live<SalesPerformanceOverview>('GET',`${SALES_PERFORMANCE_ROUTES.performance}?${params}`);
    },
    salesPerformanceGrades:(query:CustomerGradeQuery)=>{
      if(!query||!salesWindow(query.from,query.to)||!salesUuid(query.customerId)||!salesUuid(query.teamId)||!salesUuid(query.memberUserId)||!salesPage(query.limit,query.offset))return Promise.resolve(failure('INVALID_INPUT','客户分级查询参数无效'));
      if(port.salesPerformanceGrades)return port.salesPerformanceGrades(query);
      const params=new URLSearchParams({from:query.from,to:query.to,limit:String(query.limit),offset:String(query.offset)});
      for(const key of ['customerId','teamId','memberUserId'] as const)if(query[key])params.set(key,query[key]!);
      return live<CustomerGradePage>('GET',`${SALES_PERFORMANCE_ROUTES.customerGrades}?${params}`);
    },
    setSalesPerformanceGrade:(input:CustomerGradeOverrideSet)=>{
      if(!input||!salesUuid(input.customerId)||!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<0||!CUSTOMER_GRADES.includes(input.grade)||typeof input.reason!=='string'||!input.reason.trim()||typeof input.idempotencyKey!=='string'||!input.idempotencyKey.trim())return Promise.resolve(failure('INVALID_INPUT','客户等级覆盖参数无效'));
      return port.setSalesPerformanceGrade?.(input)??live<CustomerGradeOverrideReceipt>('POST',`${SALES_PERFORMANCE_ROUTES.customerGrades}/${encodeURIComponent(input.customerId)}/override`,{
        expectedVersion:input.expectedVersion,grade:input.grade,reason:input.reason,idempotencyKey:input.idempotencyKey,
      });
    },
    clearSalesPerformanceGrade:(input:CustomerGradeOverrideClear)=>{
      if(!input||!salesUuid(input.customerId)||!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<1||typeof input.reason!=='string'||!input.reason.trim()||typeof input.idempotencyKey!=='string'||!input.idempotencyKey.trim())return Promise.resolve(failure('INVALID_INPUT','客户等级清除参数无效'));
      return port.clearSalesPerformanceGrade?.(input)??live<CustomerGradeOverrideReceipt>('DELETE',`${SALES_PERFORMANCE_ROUTES.customerGrades}/${encodeURIComponent(input.customerId)}/override`,{
        expectedVersion:input.expectedVersion,reason:input.reason,idempotencyKey:input.idempotencyKey,
      });
    },
  };
}
