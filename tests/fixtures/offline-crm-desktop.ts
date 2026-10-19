/** Isolated real ONLINE IPC + SQLite + preload + production renderer. */
import { app, BrowserWindow, ipcMain } from 'electron';
import { resolve } from 'node:path';
import { registerOnlineCrmIPC, closeOnlineCrmSession, startContactMailDataflow } from '../../src/main/transport/online-crm.ipc';
import { IPC } from '../../src/main/contract';
import { selectAccountRoot } from '../../src/main/config';
import { initDatabase, runMigrations, closeDatabase } from '../../src/main/db';
const root=process.env.SMOKE_PROFILE!;
if(!root)throw new Error('SMOKE_PROFILE required');
app.setPath('userData',resolve(root));
app.whenReady().then(async()=>{
  registerOnlineCrmIPC();
  if(process.env.SMOKE_CONTACT_DATAFLOW==='1'){
    selectAccountRoot(root);
    await initDatabase();
    runMigrations();
    await startContactMailDataflow(()=>{});
  }
  for(const [domain,channels] of Object.entries(IPC))if(domain!=='ONLINE')for(const channel of Object.values(channels))ipcMain.handle(channel,()=>channel===IPC.SYSTEM.GET_CONFIG?{success:true,data:{general:{onboarding:'skipped'}}}:channel===IPC.SYSTEM.APP_VERSION?{success:true,data:'offline-crm-smoke'}:{success:true,data:[]});
  const win=new BrowserWindow({show:false,width:1366,height:768,webPreferences:{preload:resolve('dist/preload/index.js'),contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  await win.loadFile(resolve('dist/renderer/index.html'),{hash:'/customers'});
}).catch(error=>{console.error(error.message);app.exit(1);});
app.on('before-quit',()=>{closeOnlineCrmSession();if(process.env.SMOKE_CONTACT_DATAFLOW==='1')closeDatabase();});
app.on('window-all-closed',()=>app.quit());
