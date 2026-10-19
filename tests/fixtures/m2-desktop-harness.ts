/** Isolated desktop runtime harness: ONLINE IPC is the production implementation.
 * Only unrelated shell initialization is synthetic. No fixture bearer or business data.
 * Bundle with existing esbuild (external electron), then launch via Playwright Electron.
 */
import {app,BrowserWindow,ipcMain,dialog} from 'electron';
import * as path from 'node:path';
import {registerOnlineCrmIPC,closeOnlineCrmSession} from '../../src/main/transport/online-crm.ipc';
import {IPC} from '../../src/main/contract';

const sandbox=process.env.SMOKE_SANDBOX;
const renderer=process.env.SMOKE_RENDERER;
const preload=process.env.SMOKE_PRELOAD;
if(!sandbox || !renderer || !preload)throw new Error('SMOKE_SANDBOX/RENDERER/PRELOAD required');
app.setPath('userData',path.resolve(sandbox));
app.whenReady().then(async()=>{
  registerOnlineCrmIPC();
  for(const [domain,channels] of Object.entries(IPC)) {
    if(domain==='ONLINE')continue;
    for(const channel of Object.values(channels))ipcMain.handle(channel,()=>{
      if(channel==='system:getConfig')return {success:true,data:{general:{onboarding:'skipped'}}};
      if(channel==='system:appVersion')return {success:true,data:'M2 isolated runtime harness'};
      return {success:true,data:[]};
    });
  }
  // Optional synthetic file-picker selection still exercises the real XLSX parser.
  if(process.env.SMOKE_IMPORT_FILE)dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path.resolve(process.env.SMOKE_IMPORT_FILE!)]});
  // Hidden automation windows must keep animation frames running, as visible user windows do.
  const win=new BrowserWindow({show:false,width:1400,height:1000,webPreferences:{preload:path.resolve(preload),contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  await win.loadFile(path.resolve(renderer),{hash:'/online'});
}).catch(()=>app.exit(1));
app.on('before-quit',closeOnlineCrmSession);
app.on('window-all-closed',()=>app.quit());
