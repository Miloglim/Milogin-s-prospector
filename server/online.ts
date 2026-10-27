import {createSendAcceptanceService} from './services/send-acceptance';
import {createSendAcceptanceHandler} from './transport/send-acceptance-http';
import {SEND_ACCEPTANCE_ROUTES} from './core/send-acceptance';
import {createContactSharingService} from './services/contact-sharing';
import {createContactSharingHandler} from './transport/contact-sharing-http';
import { Pool } from "pg";
import { readOnlineDatabaseConfig } from "./adapters/postgres/config";
import { PostgresCrmRepository } from "./adapters/postgres/repository";
import { PostgresAuthRepository } from "./adapters/postgres/auth-repository";
import { PasswordAdapter,tokenAdapter } from "./adapters/password";
import { LoginRateGate } from "./adapters/login-rate";
import { onlineRuntimeDirectory, readOnlineConfig } from "./adapters/online-config";
import { initializeFixtures } from "./adapters/fixtures";
import { serverLog } from "./adapters/logger";
import { createAuthService } from "./services/auth";
import { createOnlineServer } from "./transport/http";
import { PostgresAdminRepository } from "./adapters/postgres/admin-repository";
import { createAdminService } from "./services/admin";
import { createAdminHandler } from "./transport/admin-http";
import { createAdminStatic } from "./adapters/admin-static";
import {createPasswordChangeService} from './services/password-change';
import {PostgresLeadRepository} from './adapters/postgres/lead-repository';
import {createLeadService} from './services/leads';
import {createContactAssignmentService} from './services/contact-assignments';
import {createContactAssignmentHandler} from './transport/contact-assignments-http';
import {CONTACT_ASSIGNMENT_ROUTES} from './core/contact-assignments';
import {migrateContactAssignmentGroups} from './adapters/postgres/contact-assignment-group-schema';
import {createContactMailService} from './services/contact-mail';
import {createContactMailHandler} from './transport/contact-mail-http';
import {CONTACT_MAIL_ROUTE} from './core/contact-mail';
import {createCrmHandler} from './transport/crm-http';
import {PostgresNotificationRepository} from './adapters/postgres/notification-repository';
import {createNotificationService} from './services/notifications';
import {createEventsHandler} from './transport/events-http';
import {startNotificationDispatcher} from './adapters/notification-dispatcher';
import {NOTIFICATION_ROUTES} from './core/notifications';
import { createDesktopSessionService } from './services/desktop-session';
import { createDesktopAuthHandler } from './transport/desktop-auth-http';
import { loadOfflineAccessIssuer } from './adapters/offline-access';
import { PostgresTaskRepository } from './adapters/postgres/task-repository';
import { createTaskService } from './services/tasks';
import { createTaskHandler } from './transport/tasks-http';
import { startTaskDispatcher } from './adapters/task-dispatcher';
import { TASK_ROUTES } from './core/tasks';
import { OPPORTUNITY_ROUTES } from './core/opportunities';
import { PostgresOpportunityRepository } from './adapters/postgres/opportunity-repository';
import { createOpportunityService } from './services/opportunities';
import { createOpportunityHandler } from './transport/opportunities-http';
import { createManagementDashboardService } from './services/management-dashboard';
import { createAdminDataBrowserService } from './services/admin-data-browser';
import { PostgresContactChangeRepository } from './adapters/postgres/contact-change-repository';
import { createContactChangeService } from './services/contact-change-feed';
import { createContactChangeHandler } from './transport/contact-change-http';
import { CONTACT_CHANGE_ROUTE } from './core/contact-change-feed';
import { PostgresCampaignRepository } from './adapters/postgres/campaign-repository';
import { createCampaignService } from './services/campaigns';
import { createCampaignHandler } from './transport/campaigns-http';
import { CAMPAIGN_ROUTES } from './core/campaigns';

const EXIT_FAILED = 1;
const SHUTDOWN_TIMEOUT_MS = 5000;
async function main() {
  const config=readOnlineConfig(), pool=new Pool(readOnlineDatabaseConfig());
  let started=false;
  try {
    const crm=new PostgresCrmRepository(pool,serverLog), repo=new PostgresAuthRepository(pool,serverLog);
    if(!(await crm.migrate()).ok || !(await repo.migrate()).ok) throw new Error("迁移被拒绝");
    const passwords=new PasswordAdapter(config.password_concurrency);
    await passwords.initialize();
    await initializeFixtures(repo,passwords,config.test_mode);
    const clock={now:()=>Date.now()}, instanceId=process.env.PROSPECTOR_ONLINE_INSTANCE;
    if(!instanceId || !/^[a-f0-9]{64}$/.test(instanceId)) throw new Error("缺少本节点启动标识");
    const auth=createAuthService(repo,passwords,tokenAdapter,clock,config.session_ttl_seconds);
    const adminRepository=new PostgresAdminRepository(pool,serverLog);
    const admin=createAdminService(adminRepository,repo,passwords,tokenAdapter,clock,auth);
    const dashboard=createManagementDashboardService(adminRepository,tokenAdapter);
    const dataBrowser=createAdminDataBrowserService(adminRepository,tokenAdapter);
    const gate=new LoginRateGate(config,clock);
    const leadRepo=new PostgresLeadRepository(pool,serverLog), notificationRepo=new PostgresNotificationRepository(pool,serverLog);
    if(!(await leadRepo.migrate()).ok || !(await notificationRepo.migrate()).ok) throw new Error('协作迁移被拒绝');
    const assignmentGroupClient=await pool.connect();try{if(!(await migrateContactAssignmentGroups(assignmentGroupClient)).ok)throw new Error('分配组迁移被拒绝');}finally{assignmentGroupClient.release();}
    const taskRepo=new PostgresTaskRepository(pool,serverLog);
    if(!(await taskRepo.migrate()).ok)throw new Error('任务迁移被拒绝');
    const opportunityRepo=new PostgresOpportunityRepository(pool,serverLog);
    if(!(await opportunityRepo.migrate()).ok)throw new Error('商机迁移被拒绝');
    const contactChangeRepo=new PostgresContactChangeRepository(pool,serverLog);
    if(!(await contactChangeRepo.migrate()).ok)throw new Error('联系人变化迁移被拒绝');
    const campaignRepo=new PostgresCampaignRepository(pool,serverLog);
    if(!(await campaignRepo.migrate()).ok)throw new Error('自动开发任务迁移被拒绝');
    const opportunities=createOpportunityHandler(createOpportunityService(opportunityRepo,tokenAdapter));
    const taskService=createTaskService(taskRepo,tokenAdapter);
    const tasks=createTaskHandler(taskService);
    const contactShares=createContactSharingHandler(createContactSharingService(leadRepo,tokenAdapter));
    const contactAssignments=createContactAssignmentHandler(createContactAssignmentService(leadRepo,tokenAdapter));
    const sendAcceptance=createSendAcceptanceHandler(createSendAcceptanceService(leadRepo,tokenAdapter));
    const contactMail=createContactMailHandler(createContactMailService(leadRepo,tokenAdapter));
    const leads=createCrmHandler(createLeadService(leadRepo,tokenAdapter));
    const notifications=createEventsHandler(createNotificationService(notificationRepo,tokenAdapter));
    const contactChanges=createContactChangeHandler(createContactChangeService(contactChangeRepo,tokenAdapter));
    const campaigns=createCampaignHandler(createCampaignService(campaignRepo,tokenAdapter));
    const collaboration:import('./transport/http').BrowserHandler=async(request,response)=>{
      const route=new URL(request.url??'/','http://localhost').pathname;
      if(Object.values(SEND_ACCEPTANCE_ROUTES).some(path=>path===route)){await sendAcceptance(request,response);return;}
      if(route===CONTACT_MAIL_ROUTE){await contactMail(request,response);return;}
      if(route==='/api/crm/contact-shares'||route.startsWith('/api/crm/contact-shares/')){await contactShares(request,response);return;}
      if(route==='/api/crm/companies'||route.startsWith('/api/crm/companies/')||route==='/api/crm/contacts/delete'||route===CONTACT_ASSIGNMENT_ROUTES.assignments||route.startsWith(`${CONTACT_ASSIGNMENT_ROUTES.assignments}/`)||route===CONTACT_ASSIGNMENT_ROUTES.groups||route.startsWith(`${CONTACT_ASSIGNMENT_ROUTES.groups}/`)||route.startsWith('/api/crm/contacts/')){await contactAssignments(request,response);return;}
      if(route===TASK_ROUTES.tasks || route.startsWith(`${TASK_ROUTES.tasks}/`)){await tasks(request,response);return;}
      if(route===OPPORTUNITY_ROUTES.opportunities || route.startsWith(`${OPPORTUNITY_ROUTES.opportunities}/`)){await opportunities(request,response);return;}
      if(route===CONTACT_CHANGE_ROUTE){await contactChanges(request,response);return;}
      if(route===CAMPAIGN_ROUTES.campaigns||route.startsWith(`${CAMPAIGN_ROUTES.campaigns}/`)){await campaigns(request,response);return;}
      await (route===NOTIFICATION_ROUTES.events || route===NOTIFICATION_ROUTES.feed || route.startsWith(`${NOTIFICATION_ROUTES.feed}/`) ? notifications : leads)(request,response);
    };
    const offlineIssuer=loadOfflineAccessIssuer(onlineRuntimeDirectory(),config.public_origin ?? `http://${config.host}:${config.port}`);
    const desktop=createDesktopAuthHandler(createDesktopSessionService(repo,passwords,tokenAdapter,clock,config.session_ttl_seconds,offlineIssuer),gate,config);
    const server=createOnlineServer(auth,gate,config,serverLog,instanceId,createAdminHandler(auth,admin,tokenAdapter,gate,config,createAdminStatic(),createPasswordChangeService(repo,repo,passwords,tokenAdapter,auth),dashboard,dataBrowser),collaboration,desktop);
    await new Promise<void>((resolve,reject) => { server.once("error",reject); server.listen(config.port,config.host,resolve); });
    started=true;
    const dispatcher=startNotificationDispatcher(notificationRepo,serverLog);
    const taskDispatcher=startTaskDispatcher(taskService,serverLog);
    serverLog.write("INFO","identity.runtime",`中心服务就绪 ${config.host}:${config.port}`);
    let closing=false;
    const stop=() => {
      if(closing) return; closing=true;
      const timer=setTimeout(()=>{ server.closeAllConnections(); },SHUTDOWN_TIMEOUT_MS);
      server.close(()=>{ clearTimeout(timer); void Promise.all([taskDispatcher.stop(),dispatcher.stop()]).then(()=>pool.end()).catch(()=>{ serverLog.write("ERROR","identity.runtime","连接池关闭失败"); process.exitCode=EXIT_FAILED; }); });
    };
    process.on("SIGTERM",stop); process.on("SIGINT",stop);
    server.on("error",()=>{ serverLog.write("ERROR","identity.runtime","服务运行错误"); process.exitCode=EXIT_FAILED; stop(); });
  } finally { if(!started) await pool.end(); }
}
void main().catch(()=>{ serverLog.write("ERROR","identity.runtime","中心启动失败；检查隔离配置与本机日志"); process.exitCode=EXIT_FAILED; });
