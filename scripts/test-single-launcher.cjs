// Isolated userData; no login or business writes. Uses the running single launcher.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {_electron,chromium}=require(path.join(process.env.CODEX_NODE_PACKAGES,'playwright'));
const root=process.cwd(),profile=fs.mkdtempSync(path.join(os.tmpdir(),'prospector-single-check-'));
const bootstrap=path.join(profile,'launch.cjs'),url=process.env.SMOKE_RENDERER_URL;
assert.ok(url,'SMOKE_RENDERER_URL must point to the running launcher');
fs.writeFileSync(bootstrap,`const {app}=require('electron');app.setPath('userData',${JSON.stringify(profile)});require(${JSON.stringify(path.join(root,'dist/main/index.js'))});`);
let app,browser;const errors=[];
(async()=>{
 const env={...process.env,NODE_OPTIONS:'',ELECTRON_RENDERER_URL:url};
 for(const key of ['ELECTRON_RUN_AS_NODE','PROSPECTOR_DEV_PROFILE','PROSPECTOR_DEV_AUTOLOGIN'])delete env[key];
 app=await _electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[bootstrap,'--remote-debugging-port=0'],env,cwd:root});
 const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.locator('#email').waitFor();
 const debugPort=Number(fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);
 await app.evaluate(({app})=>{app.relaunch();setTimeout(()=>app.exit(0),100);});
 await app.waitForEvent('close');app=null;
 const deadline=Date.now()+30000;
 while(Date.now()<deadline){try{const nextPort=Number(fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0])||debugPort;browser=await chromium.connectOverCDP(`http://127.0.0.1:${nextPort}`);break;}catch{await new Promise(r=>setTimeout(r,300));}}
 assert.ok(browser,'replacement Electron did not start');
 const replacement=browser.contexts()[0].pages()[0];replacement.on('pageerror',e=>errors.push(e.message));await replacement.locator('#email').waitFor();
 assert.equal((await fetch(url)).ok,true);assert.deepEqual(errors,[]);
 await replacement.screenshot({path:path.join(root,'.work/single-start-relaunch.png')});
 const report={ok:true,checks:['production main renders login with isolated userData','Electron relaunch replacement renders login','single launcher page service survives relaunch'],pageErrors:errors};
 fs.writeFileSync(path.join(root,'.work/single-start-relaunch-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
 if(app)await app.close();if(browser)await browser.close();
 try{execFileSync('powershell.exe',['-NoProfile','-Command',`Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'electron.exe' -and $_.CommandLine -and $_.CommandLine.Contains('${profile.replaceAll("'","''")}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],{windowsHide:true,stdio:'ignore'});}catch{/* A test process that already exited needs no cleanup. */}
});
