import { BrowserWindow, ipcMain, shell } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IPC } from '../contract';
import { OnlineCrmAdapter } from '../adapters/online-crm.adapter';
import { createOnlineCrmService } from '../services/online-crm.service';
import { failure, success } from '../../../server/core/crm';
import { Log } from '../logger';
import { createOnlineSessionStore } from '../adapters/online-session-store.adapter';
import { app } from 'electron';
import { createOfflineCrmStore } from '../adapters/offline-crm-store.adapter';
import { createOfflineCrmService } from '../services/offline-crm.service';
import { randomUUID } from 'node:crypto';
import { developerProfileRoot } from '../adapters/desktop-local-scope.adapter';
import { readConfiguredCenterBase } from '../adapters/center-endpoint.adapter';
import { loadDesktopDeviceContext } from '../adapters/desktop-device.adapter';
import type { OnlineLogout } from '../../shared/online-crm';
import { inspectLocalHandoffData } from '../services/device-handoff.service';
import { setCenterAiSessionProvider } from '../services/center-ai-session.service';
import { EVENTS } from '../events';
import { setSalesWorkflowClient } from '../services/sales-workflow-client.service';
import { startSampleMailAutoSync } from '../services/sample-mail-sync.service';
import { setCenterAccessTokenProvider } from '../services/center-identity.service';
const listeners=new Set<()=>void>();
let localAvailable=()=>false;
let accountSwitchLifecycle:{begin:()=>void;finish:(ok:boolean)=>void}={begin(){},finish(){}};
let crmStore:ReturnType<typeof createOfflineCrmStore>|undefined;
let mailRuntime:ReturnType<typeof import('../adapters/contact-mail-runtime.adapter').startContactMailRuntime>|undefined;
let handoffPause=()=>{};
let handoffResume=()=>{};
let teamEventStop:(()=>void)|null=null;
export function configureOnlineHandoffRuntime(runtime:{pause:()=>void;resume:()=>void}):void { handoffPause=runtime.pause;handoffResume=runtime.resume; }
export async function startContactMailDataflow(changed:()=>void):Promise<void> {
  if(mailRuntime)return;
  const {startContactMailRuntime}=await import('../adapters/contact-mail-runtime.adapter');
  const {createMailAnalysisAnalyzer}=await import('../services/mail-analysis-analyzer.service');
  mailRuntime=startContactMailRuntime(developerProfileRoot(process.env.PROSPECTOR_DEV_PROFILE,app.isPackaged)??app.getPath('userData'),adapter,changed,createMailAnalysisAnalyzer());
}
const localCrm=createOfflineCrmService({
  load:ctx=>{crmStore??=createOfflineCrmStore(developerProfileRoot(process.env.PROSPECTOR_DEV_PROFILE,app.isPackaged)??app.getPath('userData'));return crmStore.store.load(ctx);},
  save:(ctx,state)=>{if(!crmStore)throw new Error('客户离线库未初始化');crmStore.store.save(ctx,state);},
},randomUUID,()=>new Date().toISOString(),error=>Log.error('offline.sync',`客户同步失败 (${error instanceof Error?error.name:'unknown'})`));
const configuredCenterBase=readConfiguredCenterBase();
const desktopDevice=loadDesktopDeviceContext(
  developerProfileRoot(process.env.PROSPECTOR_DEV_PROFILE,app.isPackaged)??app.getPath('userData'),
  typeof app.getVersion==='function'?app.getVersion():'0.0.0',
);
Log.warn('online.center',`启动中心地址 ${configuredCenterBase}`);
const adapter=new OnlineCrmAdapter(fetch,createOnlineSessionStore(),()=>{
  for(const listener of listeners)try{listener();}catch{Log.error('online.identity','身份现场清理失败');}
},localCrm,configuredCenterBase,desktopDevice);
setCenterAiSessionProvider(() => adapter.aiSession());
setCenterAccessTokenProvider(() => adapter.aiSession()?.accessToken ?? null);
adapter.setHandoffRuntime({inspect:inspectLocalHandoffData,pause:()=>handoffPause(),resume:()=>handoffResume()});
export const getOnlineIdentity=()=>adapter.currentIdentity();
export const isOnlineConnection=()=>adapter.isOnline();
export const onOnlineResponse=(observer:(context:{baseUrl:string;userId:string},method:string,path:string,data:unknown)=>void):(()=>void)=>adapter.onResponse(observer);
export const loginDevelopmentIdentity=(input:import('../../shared/online-crm').OnlineLogin)=>adapter.login(input);
export function onOnlineIdentityChanged(listener:()=>void):()=>void {listeners.add(listener);return()=>{listeners.delete(listener);};}
export function configureOnlineLocalScope(reader:()=>boolean):void {localAvailable=reader;}
export function configureOnlineAccountSwitchLifecycle(lifecycle:{begin:()=>void;finish:(ok:boolean)=>void}):void {accountSwitchLifecycle=lifecycle;}
export function registerOnlineCrmIPC() {
  const service=createOnlineCrmService(adapter);
  startSampleMailAutoSync(adapter, join(app.getPath('userData'), 'sample-mail-sync.json'));
  setSalesWorkflowClient(adapter);
  const logout=async(input?:OnlineLogout)=>{
    const switching=input?.switchAccount===true;
    if(switching)accountSwitchLifecycle.begin();
    try{const result=await service.logout(input);if(switching)accountSwitchLifecycle.finish(result.ok);return result;}
    catch(error){if(switching)accountSwitchLifecycle.finish(false);throw error;}
  };
  const status=async(restore=false)=>{const result=await (restore?service.restore():service.status());return result.ok?{ok:true as const,data:{...result.data,localAvailable:localAvailable()}}:result;};
  const openTeamFile=async(fileId:string)=>{
    const result=await service.teamFileOpen(fileId);
    if(!result.ok)return result;
    try {
      const dir=join(app.getPath('temp'),'prospector-team-files');
      await mkdir(dir,{recursive:true});
      const safe=result.data.filename.replace(/[^A-Za-z0-9._\-\u4e00-\u9fff]/g,'_').slice(-120)||'team-file';
      const path=join(dir,`${randomUUID()}-${safe}`);
      await writeFile(path,Buffer.from(result.data.dataBase64,'base64'),{mode:0o600});
      const error=await shell.openPath(path);
      return error?failure('UNAVAILABLE','文件已下载但无法打开'):success({opened:true});
    } catch(error) {
      Log.error('team.file','打开临时文件失败',error instanceof Error?error.stack:undefined);
      return failure('UNAVAILABLE','无法打开文件');
    }
  };
  const startTeamEvents=async()=>{
    teamEventStop?.();
    teamEventStop=null;
    const result=await service.teamEvents(event=>{ for(const win of BrowserWindow.getAllWindows()) if(!win.isDestroyed()) win.webContents.send(EVENTS.TEAM_EVENT,event); },()=>{ for(const win of BrowserWindow.getAllWindows()) if(!win.isDestroyed()) win.webContents.send(EVENTS.TEAM_EVENT_STATE,{active:false}); });
    if(result.ok){ teamEventStop=result.data; return success({active:true}); }
    return result;
  };
  const stopTeamEvents=()=>{ teamEventStop?.(); teamEventStop=null; return success({active:false}); };
  // Dedicated center contact query; legacy contacts IPC remains local until its whole command chain is adapted.
  const retiredWorkbook=()=>failure('UNAVAILABLE','请使用单表导入');
  const handlers={ACCOUNT_PROFILE:service.accountProfile,CONTACT_SHARES:service.contactShares,CONTACT_SHARE_CREATE:service.createContactShare,CONTACT_SHARE_DECIDE:service.decideContactShare,CONTACT_SHARE_UPDATE:service.updateContactShare,CONTACT_SHARE_TEAM:service.shareContactWithTeam,CONTACT_SHARE_MEMBERS:service.contactShareMembers,CONTACT_DELETE:service.deleteContacts,COMPANY_LIST:service.companies,COMPANY_DETAIL:service.companyDetail,COMPANY_CREATE:service.createCompany,COMPANY_DELETE:service.deleteCompany,ACCOUNT_LIST:service.accounts,ACCOUNT_LOGIN:service.loginAccount,ACCOUNT_REMOVE:service.removeAccount,REGISTER:service.register,LOGIN:service.login,HANDOFF_BEGIN:service.beginHandoff,HANDOFF_STATUS:service.handoffStatus,HANDOFF_COMPLETE:service.completeHandoff,HANDOFF_TAKEOVER:service.takeoverHandoff,HANDOFF_CANCEL:service.cancelHandoff,LOGOUT:logout,STATUS:()=>status(),RESTORE:()=>status(true),PASSWORD:service.changePassword,BOOTSTRAP:service.bootstrap,PREVIEW:service.preview,IMPORT:service.importRows,LEAD_INGRESS_DECISION:service.leadIngressDecision,LEAD_INGRESS_RESOLVE:service.resolveLeadIngress,WORKBOOK_PREVIEW:retiredWorkbook,WORKBOOK_IMPORT:retiredWorkbook,PUBLISH:service.publish,COMPANY_UPDATE:service.companyUpdate,CONTACT_LIST:service.contacts,CONTACT_GROUPS:service.contactGroups,CONTACT_DETAIL:service.contactDetail,CONTACT_MONITOR_DETAIL:service.contactMonitorDetail,CONTACT_UPDATE:service.contactUpdate,CONTACT_FOLLOWUP:service.contactFollowup,CUSTOMER_STATUS:service.customerStatus,CUSTOMER_STATUS_CORRECT:service.customerStatusCorrect,CUSTOMER_STATUS_RESUME:service.customerStatusResume,ASSIGNMENT_LIST:service.assignments,ASSIGNMENT_GROUPS:service.assignmentGroups,ASSIGNMENT_CREATE:service.createAssignments,ASSIGNMENT_ACCEPT:service.acceptAssignment,ASSIGNMENT_REJECT:service.rejectAssignment,ASSIGNMENT_CANCEL:service.cancelAssignment,ASSIGNMENT_TRANSFER:service.transferAssignment,ASSIGNMENT_EXPIRE:service.expireAssignments,ASSIGNMENT_GROUP_ACCEPT:service.acceptAssignmentGroup,ASSIGNMENT_GROUP_REJECT:service.rejectAssignmentGroup,ASSIGNMENT_GROUP_CANCEL:service.cancelAssignmentGroup,LIST:service.list,DETAIL:service.detail,CREATE_CUSTOMER:service.createCustomer,UPDATE_CUSTOMER:service.updateCustomer,MEMBERS:service.members,FOLLOWUP:service.followup,FEED:service.feed,READ:service.read,READ_ALL:service.readAll,TASK_LIST:service.tasks,TASK_CREATE:service.createTask,TASK_RESCHEDULE:service.rescheduleTask,TASK_COMPLETE:service.completeTask,TASK_CANCEL:service.cancelTask,TEAM_ATTENTION_LIST:service.teamAttention,TEAM_ATTENTION_CREATE:service.createTeamAttention,TEAM_ATTENTION_ACKNOWLEDGE:(id:string,input:Omit<import('../../../server/core/team-attention').TeamAttentionTransition,'itemId'|'action'>)=>service.acknowledgeTeamAttention(id,input),TEAM_ATTENTION_DISMISS:(id:string,input:Omit<import('../../../server/core/team-attention').TeamAttentionTransition,'itemId'|'action'>)=>service.dismissTeamAttention(id,input),TEAM_ATTENTION_RESOLVE:(id:string,input:Omit<import('../../../server/core/team-attention').TeamAttentionTransition,'itemId'|'action'>)=>service.resolveTeamAttention(id,input),TEAM_MONITORING:service.teamMonitoring,TEAM_MONITORING_MEMBER:service.teamMonitoringMember,TEAM_MONITORING_CONTACT:service.teamMonitoringContact,TEAM_MONITORING_MAIL:service.teamMonitoringMail,SALES_PERFORMANCE:service.salesPerformance,SALES_PERFORMANCE_GRADES:service.salesPerformanceGrades,SALES_PERFORMANCE_GRADE_SET:service.setSalesPerformanceGrade,SALES_PERFORMANCE_GRADE_CLEAR:service.clearSalesPerformanceGrade,CONTACT_MAIL_ANALYSIS:service.contactMailAnalysis,CONTACT_MAIL_ANALYSIS_AI:service.submitContactMailAnalysis,CONTACT_MAIL_ANALYSIS_CORRECT:service.correctContactMailAnalysis,CONTACT_MAIL_ANALYSIS_QUEUE:()=>success(mailRuntime?.mailAnalysisQueueStatus()??{enabled:false,pending:0,running:0,retrying:0,completed:0,failed:0,lastError:null}),TEAM_CONTEXT:service.teamContext,TEAM_DETAIL:service.teamDetail,TEAM_CANDIDATES:service.teamCandidates,TEAM_CREATE:service.teamCreate,TEAM_INVITE:service.teamInvite,TEAM_MOVE:service.teamMove,TEAM_DISSOLVE:service.teamDissolve,TEAM_LEADER:service.teamAssignLeader,TEAM_MEMBER:service.teamAdjustMember,TEAM_GROUP_SAVE:service.teamSaveMemberGroup,TEAM_GROUP_DELETE:service.teamDeleteMemberGroup,TEAM_INVITATION_ACCEPT:(id:string,input:import('../../shared/online-crm').TeamInvitationDecision)=>service.teamInvitation(id,'accept',input),TEAM_INVITATION_DECLINE:(id:string,input:import('../../shared/online-crm').TeamInvitationDecision)=>service.teamInvitation(id,'decline',input),TEAM_INVITATION_CANCEL:(id:string,input:import('../../shared/online-crm').TeamInvitationDecision)=>service.teamInvitation(id,'cancel',input),OPPORTUNITY_LIST:service.opportunities,OPPORTUNITY_CREATE:service.createOpportunity,OPPORTUNITY_DETAIL:service.opportunityDetail,OPPORTUNITY_STAGE:service.opportunityStage,SYNC_STATUS:()=>adapter.syncStatus(),SYNC_NOW:()=>adapter.syncNow(),SYNC_RESOLVE:(input:import('../../shared/online-crm').CrmSyncResolve)=>adapter.syncResolve(input)};
  const allHandlers={...handlers,SALES_CASE_LIST:service.salesCaseList,SALES_CASE_DETAIL:service.salesCaseDetail,SALES_CASE_OVERVIEW:service.salesCaseOverview,SALES_CASE_ENSURE:service.ensureSalesCase,SALES_CASE_PROPOSAL_LIST:service.salesCaseProposalList,SALES_CASE_PROPOSAL_CREATE:service.salesCaseProposalCreate,SALES_CASE_PROPOSAL_ACT:service.salesCaseProposalAct,QUOTE_CASE_LIST:service.quoteCaseList,QUOTE_CASE_DETAIL:service.quoteCaseDetail,QUOTE_CASE_UPSERT:service.quoteCaseUpsert,QUOTE_CASE_SELECT:service.quoteCaseSelect,QUOTE_CASE_REQUERY:service.quoteCaseRequery,QUOTE_CASE_REVIEW:service.quoteCaseReview,TEAM_MESSAGES:service.teamMessages,TEAM_MESSAGE_SEND:service.teamSendMessage,TEAM_MESSAGE_READ:service.teamMessageRead,TEAM_MESSAGE_UNREAD:service.teamMessageUnread,TEAM_CONVERSATIONS:service.teamConversations,TEAM_DIRECTORY:service.teamDirectory,TEAM_PRESENCE:service.teamPresence,TEAM_FILE_UPLOAD:service.teamFileUpload,TEAM_FILE_OPEN:openTeamFile,TEAM_ARCHIVE:service.teamArchive,TEAM_EVENTS_START:startTeamEvents,TEAM_EVENTS_STOP:stopTeamEvents};
  Object.assign(allHandlers,{QUOTE_REVIEW_LIST:service.quoteReviewList,QUOTE_REVIEW_DECIDE:service.quoteReviewDecide});
  for(const [key,handler] of Object.entries(allHandlers)) {
    ipcMain.handle(IPC.ONLINE[key as keyof typeof IPC.ONLINE],async(_event,...args:unknown[])=>{
      try { return await (handler as (...input:unknown[])=>unknown)(...args); }
      catch { Log.error('online.ipc','在线参数处理失败'); return failure('INVALID_INPUT','在线请求参数错误'); }
    });
  }
  ipcMain.handle(IPC.ONLINE.SALES_CASE_TRANSITION,async(_event,caseId:string,input:unknown)=>{
    try { return await service.transitionSalesCase(caseId,input); }
    catch { Log.error('online.ipc','销售 Case 推进失败'); return failure('INVALID_INPUT','销售 Case 推进参数错误'); }
  });
  ipcMain.handle(IPC.ONLINE.PREPARE_IMPORTED_LEADS,async(_event,input:import('../../shared/online-crm').PrepareImportedLeadsInput)=>{
    try { return await service.prepareImportedLeads(input); }
    catch { Log.error('online.ipc','导入后准备开发任务失败'); return failure('UNAVAILABLE','开发任务准备暂不可用'); }
  });
}
export function closeOnlineCrmSession() { setSalesWorkflowClient(null);mailRuntime?.close();adapter.dispose();crmStore?.close(); }
