const {app,BrowserWindow,ipcMain} = require('electron');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
let authenticated=false;
let queries=0;
let navigatorUrl='https://navigator.example';
const pixel='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
app.setPath('userData',process.env.SMOKE_SANDBOX);
app.whenReady().then(async()=>{
 const preload=path.join(process.env.SMOKE_SANDBOX,'preload.cjs');
 fs.writeFileSync(preload,`const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('api',{invoke:(channel,...args)=>ipcRenderer.invoke('fixture',channel,...args),send:()=>{},on:(channel,cb)=>{const listener=(_e,data)=>cb(data);ipcRenderer.on(channel,listener);return ()=>ipcRenderer.removeListener(channel,listener);}});`);
 const status=()=>({ok:true,data:{authenticated,baseUrl:'https://navigator.example',...(authenticated?{user:{user_id:7,name:'fixture-user',display_name:'测试账号',role:'sales'}}:{})}});
 ipcMain.handle('fixture',(_e,channel,...args)=>{
  if(channel==='rates:navigatorStatus')return status();
  if(channel==='rates:navigatorLogin'){authenticated=true;return status();}
  if(channel==='rates:navigatorLogout'){authenticated=false;return {ok:true};}
  if(channel==='rates:options')return {ok:true,data:{ports:[{n:'SANTOS',c:'桑托斯',k:'pod'},{n:'Shekou',c:'蛇口',k:'pol'}],portGroups:[],carriers:[{n:'ZIM'}],routes:[{n:'Brazil'}]}};
  if(channel==='rates:list'){assert.equal(args[0].match,'web');assert.equal(args[0].pod,'SANTOS');assert.equal(args[0].terms,undefined);queries++;return {success:true,data:[{podRaw:'SANTOS',carrier:'ZIM',container:'40HQ',oceanUsd:8100,pol:'Shekou',validTo:'2099-12-31',imageUrl:'resolved-image.png'}]};}
  if(channel==='rates:image'){assert.equal(args[0],'resolved-image.png');return {ok:true,data:pixel};}
  if(channel==='system:appVersion')return {success:true,data:'fixture'};
  if(channel==='config:load')return {success:true,data:{onboardingCompleted:true}};
  if(channel==='system:getConfig')return {success:true,data:{general:{onboarding:'skipped'},rates:{url:navigatorUrl}}};
  if(channel==='system:updateConfig'){navigatorUrl=args[0].rates.url;return {success:true};}
  if(channel==='ai:endpointStatus')return {success:false};
  return {success:true,data:[]};
 });
 const win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{preload,contextIsolation:true,nodeIntegration:false}});
 const errors=[];win.webContents.on('console-message',(_e,level,message)=>{if(level===3)errors.push(message);});
 await win.loadFile(process.env.SMOKE_RENDERER,{hash:'/rates'});
 const wait=async predicate=>{for(let i=0;i<80;i++){if(await win.webContents.executeJavaScript(predicate))return;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Renderer condition timeout: '+predicate+'; '+errors.join('\n')+'; '+await win.webContents.executeJavaScript('document.body.innerText.slice(0,1800)'));};
 const click=text=>win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.replace(/\\s+/g,'')===${JSON.stringify(text.replace(/\s+/g,''))}).click()`);
 await wait(`document.body.innerText.includes('登录 Navigator')`);
 assert.equal(queries,0);
 await click('查价');await wait(`document.body.innerText.includes('请先登录 Navigator 后查价')`);assert.equal(queries,0);
 await click('登录 Navigator');await wait(`document.body.innerText.includes('退出账号')`);assert.equal(queries,0);
 await win.webContents.executeJavaScript(`document.querySelector('[aria-label="目的港匹配"]').closest('.ant-select').querySelector('.ant-select-selector').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`);
 await wait(`!!document.querySelector('.ant-select-item-option[title="SANTOS · 桑托斯"]')`);
 await win.webContents.executeJavaScript(`document.querySelector('.ant-select-item-option[title="SANTOS · 桑托斯"]').click()`);
 await click('查价');await wait(`document.body.innerText.includes('SANTOS')`);assert.equal(queries,1);
 await click('详情');await wait(`document.querySelector('img[alt="报价截图"]')?.naturalWidth > 0`);
 await win.webContents.executeJavaScript(`document.querySelector('.ant-image-mask').click()`);
 await wait(`!!document.querySelector('.ant-image-preview-img')`);
 win.webContents.send('navigator:identityChanged',{epoch:2});
 await wait(`!document.querySelector('img[alt="报价截图"]')`);
 await wait(`!document.querySelector('.ant-image-preview-img') || document.querySelector('.ant-image-preview-wrap')?.style.display === 'none'`);
 await wait(`!document.querySelector('.ant-table-tbody')?.innerText.includes('SANTOS')`);
 await click('退出账号');await wait(`document.body.innerText.includes('登录 Navigator')`);
 await win.webContents.executeJavaScript(`location.hash='/settings'`);
 await wait(`document.querySelector('[aria-label="Navigator 服务地址"]')?.value === 'https://navigator.example'`);
 assert.equal(await win.webContents.executeJavaScript(`document.body.innerText.includes('镜像 ')`),false);
 await click('保存地址');await wait(`document.body.innerText.includes('Navigator 地址已保存')`);
 assert.equal(navigatorUrl,'https://navigator.example');
 assert.equal(queries,1);
 assert.equal(errors.length,0,errors.join('\n'));
 win.destroy();console.log('NAVIGATOR_RENDERER_SMOKE_OK');app.quit();
}).catch(error=>{console.error(error.message);app.exit(1);});
