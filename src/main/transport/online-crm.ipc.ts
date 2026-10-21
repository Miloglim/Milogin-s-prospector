import { ipcMain } from 'electron';
import { IPC } from '../contract';
import { OnlineCrmAdapter } from '../adapters/online-crm.adapter';
import { createOnlineCrmService } from '../services/online-crm.service';
import { failure } from '../../../server/core/crm';
import { Log } from '../logger';
import { createOnlineSessionStore } from '../adapters/online-session-store.adapter';
import { app } from 'electron';
import { createOfflineCrmStore } from '../adapters/offline-crm-store.adapter';
import { createOfflineCrmService } from '../services/offline-crm.service';
import { randomUUID } from 'node:crypto';
import { developerProfileRoot } from '../adapters/desktop-local-scope.adapter';
import { readConfiguredCenterBase } from '../adapters/center-endpoint.adapter';
import type { OnlineLogout } from '../../shared/online-crm';
const listeners=new Set<()=>void>();
let localAvailable=()=>false;
let accountSwitchLifecycle:{begin:()=>void;finish:(ok:boolean)=>void}={begin(){},finish(){}};
let crmStore:ReturnType<typeof createOfflineCrmStore>|undefined;
let mailRuntime:ReturnType<typeof import('../adapters/contact-mail-runtime.adapter').startContactMailRuntime>|undefined;
export async function startContactMailDataflow(changed:()=>void):Promise<void> {
  if(mailRuntime)return;
  const {startContactMailRuntime}=await import('../adapters/contact-mail-runtime.adapter');
  mailRuntime=startContactMailRuntime(developerProfileRoot(process.env.PROSPECTOR_DEV_PROFILE,app.isPackaged)??app.getPath('userData'),adapter,changed);
}
const localCrm=createOfflineCrmService({
  load:ctx=>{crmStore??=createOfflineCrmStore(developerProfileRoot(process.env.PROSPECTOR_DEV_PROFILE,app.isPackaged)??app.getPath('userData'));return crmStore.store.load(ctx);},
  save:(ctx,state)=>{if(!crmStore)throw new Error('客户离线库未初始化');crmStore.store.save(ctx,state);},
},randomUUID,()=>new Date().toISOString(),error=>Log.error('offline.sync',`客户同步失败 (${error instanceof Error?error.name:'unknown'})`));
const configuredCenterBase=readConfiguredCenterBase();
Log.warn('online.center',`启动中心地址 ${configuredCenterBase}`);
const adapter=new OnlineCrmAdapter(fetch,createOnlineSessionStore(),()=>{
  for(const listener of listeners)try{listener();}catch{Log.error('online.identity','身份现场清理失败');}
},localCrm,configuredCenterBase);
export const getOnlineIdentity=()=>adapter.currentIdentity();
export const isOnlineConnection=()=>adapter.isOnline();
export const loginDevelopmentIdentity=(input:import('../../shared/online-crm').OnlineLogin)=>adapter.login(input);
export function onOnlineIdentityChanged(listener:()=>void):()=>void {listeners.add(listener);return()=>{listeners.delete(listener);};}
export function configureOnlineLocalScope(reader:()=>boolean):void {localAvailable=reader;}
export function configureOnlineAccountSwitchLifecycle(lifecycle:{begin:()=>void;finish:(ok:boolean)=>void}):void {accountSwitchLifecycle=lifecycle;}
export function registerOnlineCrmIPC() {
  const service=createOnlineCrmService(adapter);
  const logout=async(input?:OnlineLogout)=>{
    const switching=input?.switchAccount===true;
    if(switching)accountSwitchLifecycle.begin();
    try{const result=await service.logout(input);if(switching)accountSwitchLifecycle.finish(result.ok);return result;}
    catch(error){if(switching)accountSwitchLifecycle.finish(false);throw error;}
  };
  const status=async(restore=false)=>{const result=await (restore?service.restore():service.status());return result.ok?{ok:true as const,data:{...result.data,localAvailable:localAvailable()}}:result;};
  // Dedicated center contact query; legacy contacts IPC remains local until its whole command chain is adapted.
  const retiredWorkbook=()=>failure('UNAVAILABLE','请使用单表导入');
  const handlers={ACCOUNT_PROFILE:service.accountProfile,CONTACT_SHARES:service.contactShares,CONTACT_SHARE_CREATE:service.createContactShare,CONTACT_SHARE_DECIDE:service.decideContactShare,CONTACT_SHARE_UPDATE:service.updateContactShare,CONTACT_SHARE_MEMBERS:service.contactShareMembers,CONTACT_DELETE:service.deleteContacts,COMPANY_LIST:service.companies,COMPANY_DETAIL:service.companyDetail,COMPANY_CREATE:service.createCompany,COMPANY_DELETE:service.deleteCompany,ACCOUNT_LIST:service.accounts,ACCOUNT_LOGIN:service.loginAccount,ACCOUNT_REMOVE:service.removeAccount,REGISTER:service.register,LOGIN:service.login,LOGOUT:logout,STATUS:()=>status(),RESTORE:()=>status(true),PASSWORD:service.changePassword,BOOTSTRAP:service.bootstrap,PREVIEW:service.preview,IMPORT:service.importRows,WORKBOOK_PREVIEW:retiredWorkbook,WORKBOOK_IMPORT:retiredWorkbook,PUBLISH:service.publish,COMPANY_UPDATE:service.companyUpdate,CONTACT_LIST:service.contacts,CONTACT_DETAIL:service.contactDetail,CONTACT_UPDATE:service.contactUpdate,CONTACT_FOLLOWUP:service.contactFollowup,ASSIGNMENT_LIST:service.assignments,ASSIGNMENT_CREATE:service.createAssignments,ASSIGNMENT_ACCEPT:service.acceptAssignment,ASSIGNMENT_REJECT:service.rejectAssignment,ASSIGNMENT_CANCEL:service.cancelAssignment,LIST:service.list,DETAIL:service.detail,CREATE_CUSTOMER:service.createCustomer,UPDATE_CUSTOMER:service.updateCustomer,MEMBERS:service.members,FOLLOWUP:service.followup,FEED:service.feed,READ:service.read,TASK_LIST:service.tasks,TASK_CREATE:service.createTask,TASK_RESCHEDULE:service.rescheduleTask,TASK_COMPLETE:service.completeTask,OPPORTUNITY_LIST:service.opportunities,OPPORTUNITY_CREATE:service.createOpportunity,OPPORTUNITY_DETAIL:service.opportunityDetail,OPPORTUNITY_STAGE:service.opportunityStage,SYNC_STATUS:()=>adapter.syncStatus(),SYNC_NOW:()=>adapter.syncNow(),SYNC_RESOLVE:(input:import('../../shared/online-crm').CrmSyncResolve)=>adapter.syncResolve(input)};
  for(const [key,handler] of Object.entries(handlers)) {
    ipcMain.handle(IPC.ONLINE[key as keyof typeof IPC.ONLINE],async(_event,...args:unknown[])=>{
      try { return await (handler as (...input:unknown[])=>unknown)(...args); }
      catch { Log.error('online.ipc','在线参数处理失败'); return failure('INVALID_INPUT','在线请求参数错误'); }
    });
  }
}
export function closeOnlineCrmSession() { mailRuntime?.close();adapter.dispose();crmStore?.close(); }
