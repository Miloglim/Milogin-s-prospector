/** Isolated real ONLINE IPC + SQLite + preload + production renderer. */
import { app, BrowserWindow, ipcMain } from 'electron';
import { resolve } from 'node:path';
import { registerOnlineCrmIPC, closeOnlineCrmSession, configureOnlineLocalScope, startContactMailDataflow } from '../../src/main/transport/online-crm.ipc';
import { IPC } from '../../src/main/contract';
import { selectAccountRoot } from '../../src/main/config';
import { initDatabase, runMigrations, closeDatabase, getRawDb } from '../../src/main/db';
import * as InboxService from '../../src/main/services/inbox.service';
const root=process.env.SMOKE_PROFILE!;
if(!root)throw new Error('SMOKE_PROFILE required');
app.setPath('userData',resolve(root));
app.whenReady().then(async()=>{
  registerOnlineCrmIPC();
  if(process.env.SMOKE_CONTACT_DATAFLOW==='1'||process.env.SMOKE_LOCAL_DB==='1'){
    selectAccountRoot(root);
    await initDatabase();
    runMigrations();
    const raw=getRawDb();
    raw.prepare("INSERT OR IGNORE INTO email_accounts (id,email,encrypted_pass) VALUES (1,'fixture@example.invalid','fixture')").run();
    raw.prepare("INSERT OR IGNORE INTO inbox_messages (id,account_id,message_id,from_email,from_name,subject,body_preview,classification,intent,is_read,received_at) VALUES (1,1,'fixture-message','fixture@example.invalid','Fixture Buyer','Fixture pricing reply','Fixture body','replied','price_inquiry',1,CURRENT_TIMESTAMP)").run();
    configureOnlineLocalScope(()=>true);
    if(process.env.SMOKE_CONTACT_DATAFLOW==='1')await startContactMailDataflow(()=>{});
  }
  for(const [domain,channels] of Object.entries(IPC))if(domain!=='ONLINE')for(const channel of Object.values(channels))ipcMain.handle(channel,async(_event,input?:unknown)=>{
    if(channel===IPC.SYSTEM.GET_CONFIG)return {success:true,data:{general:{onboarding:'skipped'}}};
    if(channel===IPC.SYSTEM.APP_VERSION)return {success:true,data:'offline-crm-smoke'};
    if(channel===IPC.DASHBOARD.STATS)return {success:true,data:{totalContacts:0,totalSent:0,totalReplied:0,bounceCount:0,pipelineSummary:{},recentActivity:[]}};
    if(process.env.SMOKE_INBOX_PROGRESS==='1'&&channel===IPC.INBOX.SYNC_STATE)return {success:true,data:{accounts:[{accountId:1,email:'fixture@example.invalid',hasImap:true,phase:'ready',windowFromAt:null,windowToAt:null,targetCount:0,scannedCount:0,newCount:0,matchedCount:0,remainingCount:0,firstCompletedAt:new Date().toISOString(),lastIncrementalAt:null,lastError:null,updatedAt:null}],initializing:false,failed:false}};
    if(process.env.SMOKE_INBOX_PROGRESS==='1'&&channel===IPC.INBOX.FETCH){
      BrowserWindow.getAllWindows()[0]?.webContents.send('inbox:fetchProgress',{accountId:1,email:'fixture@example.invalid',phase:'scanning',scanned:125,total:500,newCount:5,remaining:20,processedCount:125,requiredCount:500,currentSubject:'Fixture pricing reply'});
      await new Promise(resolve=>setTimeout(resolve,300));
      BrowserWindow.getAllWindows()[0]?.webContents.send('inbox:fetchProgress',{accountId:1,email:'fixture@example.invalid',phase:'scanning',scanned:126,total:500,newCount:5,remaining:20,processedCount:126,requiredCount:500,currentSubject:'Next fixture reply'});
      await new Promise(resolve=>setTimeout(resolve,2500));
      return {success:true,data:[]};
    }
    if(process.env.SMOKE_INBOX_PROGRESS==='1'&&channel===IPC.INBOX.LIST)return InboxService.listInbox(input as {includeId?:number}|undefined);
    if(process.env.SMOKE_INBOX_PROGRESS==='1'&&channel===IPC.INBOX.GET_BODY)return {success:true,data:'<p>Fixture pricing reply</p>'};
    if(channel===IPC.INBOX.LABELS)return InboxService.listInboxLabels();
    if(channel===IPC.INBOX.LABEL_SAVE)return InboxService.saveInboxLabel(input as Parameters<typeof InboxService.saveInboxLabel>[0]);
    if(channel===IPC.INBOX.LABEL_DELETE)return InboxService.deleteInboxLabel(input as Parameters<typeof InboxService.deleteInboxLabel>[0]);
    if(channel===IPC.INBOX.MESSAGE_LABELS)return InboxService.setInboxMessageLabels(input as Parameters<typeof InboxService.setInboxMessageLabels>[0]);
    return {success:true,data:[]};
  });
  const win=new BrowserWindow({show:false,width:1366,height:768,webPreferences:{preload:resolve('dist/preload/index.js'),contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  await win.loadFile(resolve('dist/renderer/index.html'),{hash:process.env.SMOKE_ROUTE||'/customers'});
}).catch(error=>{console.error(error.message);app.exit(1);});
app.on('before-quit',()=>{closeOnlineCrmSession();if(process.env.SMOKE_CONTACT_DATAFLOW==='1'||process.env.SMOKE_LOCAL_DB==='1')closeDatabase();});
app.on('window-all-closed',()=>app.quit());
