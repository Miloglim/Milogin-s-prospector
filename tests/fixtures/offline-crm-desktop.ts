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
    if(process.env.SMOKE_INBOX_BULK==='1'){
      const insert=raw.prepare("INSERT OR IGNORE INTO inbox_messages (id,account_id,message_id,from_email,from_name,subject,body_preview,classification,is_read,received_at) VALUES (?,1,?,?,?,?,?,'replied',1,?)");
      raw.transaction(()=>{
        const newest=Date.UTC(2026,10,16,12,0,0);
        for(let index=1;index<=450;index+=1){
          const label=String(index).padStart(3,'0');
          insert.run(10000+index,`bulk-${label}`,`bulk-${label}@example.invalid`,`Bulk Buyer ${label}`,`Bulk mail ${label}`,`Bulk body ${label}`,new Date(newest-index*1000).toISOString());
        }
      })();
    }
    if(process.env.SMOKE_CAMPAIGN_INBOX==='1'){
      raw.prepare("INSERT OR IGNORE INTO inbox_messages (id,account_id,message_id,from_email,from_name,subject,body_preview,classification,matched_contact_id,is_read,received_at) VALUES (101,1,'campaign-reply','buyer@campaign.invalid','Campaign Buyer','Campaign reply','Campaign reply body','replied',7,1,'2026-11-17T02:00:00Z')").run();
      raw.prepare("INSERT OR IGNORE INTO inbox_messages (id,account_id,message_id,from_email,from_name,subject,body_preview,classification,matched_contact_id,is_read,received_at) VALUES (102,1,'campaign-bounce','buyer@campaign.invalid','Mail Delivery','Campaign bounce','Campaign bounce body','bounce',7,1,'2026-11-17T01:00:00Z')").run();
      raw.prepare("INSERT OR IGNORE INTO inbox_messages (id,account_id,message_id,from_email,from_name,subject,body_preview,classification,matched_contact_id,is_read,received_at) VALUES (103,1,'other-reply','other@example.invalid','Other Buyer','Other reply','Other reply body','replied',99,1,'2026-11-17T00:00:00Z')").run();
    }
    configureOnlineLocalScope(()=>true);
    if(process.env.SMOKE_CONTACT_DATAFLOW==='1')await startContactMailDataflow(()=>{});
  }
  for(const [domain,channels] of Object.entries(IPC))if(domain!=='ONLINE')for(const channel of Object.values(channels))ipcMain.handle(channel,async(_event,input?:unknown)=>{
    if(channel===IPC.SYSTEM.GET_CONFIG)return {success:true,data:{general:{onboarding:'skipped'}}};
    if(channel===IPC.SYSTEM.APP_VERSION)return {success:true,data:'offline-crm-smoke'};
    if(process.env.SMOKE_CAMPAIGN_INBOX==='1'&&channel===IPC.SEND.CAMPAIGNS)return {success:true,data:[{id:'campaign-1',name:'Brazil outreach',status:'running',autoSend:false,planRounds:1,total:1,pending:0,queued:0,sent:1,replied:2,bounced:1,autoreply:0,unsubscribed:0,skipped:0,touchesSent:1,touchesPlanned:1,queuedGroups:0,createdAt:'2026-11-17T00:00:00Z'}]};
    if(process.env.SMOKE_CAMPAIGN_INBOX==='1'&&channel===IPC.SEND.CAMPAIGN_DETAIL)return {success:true,data:{campaign:{id:'campaign-1',name:'Brazil outreach',status:'running',autoSend:false,planRounds:1,touchesSent:1,touchesPlanned:1},targets:[{contactId:7,name:'Campaign Buyer',email:'buyer@campaign.invalid',status:'replied',round:1,nextTouchAt:null,lastSentAt:'2026-11-17T00:00:00Z'}],raw:null}};
    if(process.env.SMOKE_INBOX_PROGRESS==='1'&&channel===IPC.INBOX.SYNC_STATE)return {success:true,data:{accounts:[{accountId:1,email:'fixture@example.invalid',hasImap:true,phase:'ready',windowFromAt:null,windowToAt:null,targetCount:0,scannedCount:0,newCount:0,matchedCount:0,remainingCount:0,firstCompletedAt:new Date().toISOString(),lastIncrementalAt:null,lastError:null,updatedAt:null}],initializing:false,failed:false}};
    if(process.env.SMOKE_INBOX_PROGRESS==='1'&&channel===IPC.INBOX.FETCH){
      BrowserWindow.getAllWindows()[0]?.webContents.send('inbox:fetchProgress',{accountId:1,email:'fixture@example.invalid',phase:'scanning',scanned:125,total:500,newCount:5,remaining:20,processedCount:125,requiredCount:500,currentSubject:'Fixture pricing reply'});
      await new Promise(resolve=>setTimeout(resolve,300));
      BrowserWindow.getAllWindows()[0]?.webContents.send('inbox:fetchProgress',{accountId:1,email:'fixture@example.invalid',phase:'scanning',scanned:126,total:500,newCount:5,remaining:20,processedCount:126,requiredCount:500,currentSubject:'Next fixture reply'});
      await new Promise(resolve=>setTimeout(resolve,2500));
      return {success:true,data:[]};
    }
    if((process.env.SMOKE_INBOX_PROGRESS==='1'||process.env.SMOKE_CAMPAIGN_INBOX==='1'||process.env.SMOKE_INBOX_BULK==='1')&&channel===IPC.INBOX.LIST){
      const request=input as Parameters<typeof InboxService.listInboxPage>[0]|undefined;
      return request?.limit!==undefined?InboxService.listInboxPage(request):InboxService.listInbox(request);
    }
    if((process.env.SMOKE_INBOX_PROGRESS==='1'||process.env.SMOKE_CAMPAIGN_INBOX==='1'||process.env.SMOKE_INBOX_BULK==='1')&&channel===IPC.INBOX.GET_BODY)return {success:true,data:'<p>Fixture pricing reply</p>'};
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
