// Synthetic center only. No production database, account or email access.
const {mkdtempSync,mkdirSync,writeFileSync}=require('node:fs');
const {tmpdir}=require('node:os');const path=require('node:path');const http=require('node:http');
const {randomUUID,randomBytes,generateKeyPairSync,sign,createPublicKey}=require('node:crypto');
const assert=require('node:assert/strict');const {buildSync}=require('esbuild');
const runtime=process.env.CODEX_NODE_PACKAGES;
if(!runtime)throw Error('CODEX_NODE_PACKAGES must point to the existing bundled packages');
const {_electron}=require(path.join(runtime,'playwright'));
const root=process.cwd(),sandbox=mkdtempSync(path.join(tmpdir(),'prospector-offline-crm-')),out=path.join(root,'.work/offline-crm');mkdirSync(out,{recursive:true});
mkdirSync(path.join(sandbox,'profile'),{recursive:true});
const bundle=path.join(out,'main.cjs');
buildSync({entryPoints:['tests/fixtures/offline-crm-desktop.ts'],outfile:bundle,bundle:true,platform:'node',format:'cjs',packages:'external'});
const userId=randomUUID(),identity={userId,displayName:'Offline Fixture',email:'fixture@example.invalid',emailVerified:true,identityAdmin:false,crmRoles:['sales'],crmCapabilities:['leads.create','leads.develop','leads.claim']};
let currentIdentity=identity;
const seedId=randomUUID(),customers=new Map([[seedId,{customerId:seedId,companyName:'Offline Fixture Company',country:'BR',version:1,state:'owned',origin:'personal',ownerUserId:userId,source:'fixture',sourceDetail:'',customerKey:seedId,stage:'cold',contactCount:1,contacts:[{contactId:1,email:'offline@example.invalid',name:'Alice',country:'BR'}],activities:[],canEdit:true,canFollowup:true,canAssign:false}]]);
const centerContact=()=>({contactId:1,customerId:seedId,customerVersion:1,contactVersion:1,companyId:1,companyName:'Offline Fixture Company',email:'offline@example.invalid',firstName:'Alice',lastName:null,title:null,phone:null,linkedinUrl:null,country:'BR',clientType:null,language:null,stage:'cold',status:'',tags:[],extra:{},touchStatus:'uncontacted',assignee:'',source:'fixture',sourceDetail:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),ownerUserId:userId,ownerName:'Offline Fixture',origin:'personal',state:'owned',assignmentStatus:null,relationshipStage:'cold',canEdit:true,canFollowup:true,canAssign:false,canDelete:false,canSendMail:true,permissions:{editableFields:[],canFollowup:true,canChangeStage:true,canSendMail:true,canShare:false}});
const key=generateKeyPairSync('ed25519').privateKey,receipts=new Map();let center,base,port,app,page;const errors=[],checks=[];let contactSequence=10;
const ok=data=>({ok:true,data}),fail=(code,message)=>({ok:false,error:{code,message}});
function grant(){const now=Date.now(),payload=JSON.stringify({version:1,audience:'prospector-local',issuer:base,issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+72*60*60*1000).toISOString(),identity:currentIdentity});return {payload,signature:sign(null,Buffer.from(payload),key).toString('base64url'),publicKey:createPublicKey(key).export({format:'pem',type:'spki'}).toString()};}
async function start(){center=http.createServer(async(req,res)=>{
  let text='';for await(const part of req)text+=part;const body=text?JSON.parse(text):undefined,url=new URL(req.url,base??'http://127.0.0.1');let answer;
  if(url.pathname.endsWith('/login')||url.pathname.endsWith('/refresh'))answer=ok({token:randomBytes(32).toString('base64url'),refreshToken:randomBytes(32).toString('base64url'),identity:currentIdentity,expiresAt:new Date(Date.now()+3600000).toISOString(),offlineAccess:grant()});
  else if(url.pathname.endsWith('/me'))answer=ok(currentIdentity);
  else if(url.pathname==='/api/crm/bootstrap')answer=ok({userId:currentIdentity.userId,capabilities:identity.crmCapabilities,scope:'own',summary:{mine:Array.from(customers.values()).filter(c=>c.ownerUserId===currentIdentity.userId).length,pool:0},feedCursor:'0'});
  else if(req.method==='GET'&&url.pathname==='/api/crm/leads'){const items=url.searchParams.get('view')==='personal'?Array.from(customers.values()).filter(c=>c.ownerUserId===currentIdentity.userId):[];answer=ok({items,total:items.length});}
  else if(req.method==='GET'&&url.pathname==='/api/crm/contact-changes'){answer=ok({items:[],nextCursor:'1',hasMore:false,headCursor:'1'});}
  else if(req.method==='GET'&&url.pathname==='/api/crm/contacts'){answer=ok({items:[centerContact()],total:1});}
  else if(req.method==='GET'&&url.pathname==='/api/crm/contacts/1'){answer=ok({contact:centerContact(),company:{companyId:1,name:'Offline Fixture Company',domain:null,backcheckData:null},activities:[],canEdit:true,canFollowup:true,canAssign:false,canDelete:false,mailAvailable:false,permissions:centerContact().permissions});}
  else if(req.method==='GET'&&/^\/api\/crm\/leads\//.test(url.pathname))answer=customers.has(url.pathname.split('/')[4])?ok(customers.get(url.pathname.split('/')[4])):fail('NOT_FOUND','missing');
  else if(req.method==='POST'&&url.pathname==='/api/crm/imports'){
    const receiptKey=url.pathname+':'+body.idempotencyKey;
    answer=receipts.get(receiptKey);
    if(!answer){const rows=body.rows.map((row,index)=>{const id=randomUUID(),contact={contactId:contactSequence++,email:row.email,name:row.name??null,country:row.country??null};customers.set(id,{customerId:id,customerKey:row.customerKey,companyName:row.companyName,country:row.country??null,source:body.source,sourceDetail:body.sourceDetail,version:1,origin:'personal',state:'owned',stage:'cold',ownerUserId:userId,contactCount:1,contacts:[contact],activities:[],canEdit:true,canFollowup:true,canAssign:false});return {index,rowId:randomUUID(),status:'created',customerId:id};});answer=ok({batchId:randomUUID(),version:1,rows});receipts.set(receiptKey,answer);}
  }
  else if(req.method==='POST'&&(url.pathname==='/api/crm/leads'||/\/(update|followups)$/.test(url.pathname))){
    const receiptKey=url.pathname+':'+body.idempotencyKey,old=receipts.get(receiptKey);
    if(old)answer=old;
    else if(url.pathname==='/api/crm/leads'){const id=randomUUID(),contacts=body.contacts.map(c=>({...c,contactId:contactSequence++,country:c.country??null,name:c.name??null}));const row={...body,customerId:id,customerKey:id,version:1,origin:'personal',state:'owned',stage:'cold',ownerUserId:userId,country:body.country??null,contactCount:contacts.length,contacts,activities:[],canEdit:true,canFollowup:true,canAssign:false};customers.set(id,row);answer=ok(structuredClone(row));}
    else {const row=customers.get(body.customerId);if(!row)answer=fail('NOT_FOUND','missing');else if(row.version!==body.expectedVersion)answer=fail('CONFLICT','中心版本已变化');else{if(url.pathname.endsWith('/update')){row.companyName=body.companyName;row.contacts=body.contacts.map(c=>({...c,contactId:c.contactId??contactSequence++}));}else{row.activities.unshift({id:randomUUID(),actorId:userId,note:body.note,method:body.method??'other',stage:body.stage??null,createdAt:new Date().toISOString()});}row.version++;answer=ok(structuredClone(row));}}
    if(answer.ok)receipts.set(receiptKey,answer);
  }
  else if(url.pathname==='/api/crm/notifications')answer=ok({items:[],nextCursor:'0',hasMore:false});
  else if(/tasks|opportunities/.test(url.pathname))answer=ok({items:[],total:0});
  else answer=ok(undefined);
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(answer));
});await new Promise(resolve=>center.listen(port??0,'127.0.0.1',resolve));port=center.address().port;base=`http://127.0.0.1:${port}`;}
async function stop(){await new Promise(resolve=>center.close(resolve));}
async function launch(){const env={...process.env,SMOKE_PROFILE:path.join(sandbox,'profile'),SMOKE_CONTACT_DATAFLOW:'1',NODE_PATH:path.join(root,'node_modules'),NODE_OPTIONS:''};for(const name of ['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','PROSPECTOR_DEV_PROFILE','PROSPECTOR_DEV_AUTOLOGIN'])delete env[name];app=await _electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[bundle],cwd:root,env});app.process().stderr.on('data',chunk=>process.stderr.write(chunk));page=await app.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message));}
const invoke=(channel,...args)=>page.evaluate(({channel,args})=>window.api.invoke(channel,...args),{channel,args});
function unwrap(result){assert.equal(result.ok,true,result.error?.message);return result.data;}
async function waitSynced(){for(let i=0;i<40;i++){const status=unwrap(await invoke('online:sync-status'));if(!status.syncing&&!status.pending&&status.lastSyncedAt)return;await page.waitForTimeout(100);}throw Error('sync timeout');}
(async()=>{
  await start();await launch();unwrap(await invoke('online:login',{baseUrl:base,email:identity.email,password:'SyntheticFixture1',remember:true}));unwrap(await invoke('online:bootstrap'));await page.evaluate(()=>{window.location.hash='#/customers';});await waitSynced();await page.getByText('联系人',{exact:true}).first().waitFor();checks.push('real IPC, preload, renderer and native SQLite online snapshot');
  await stop();assert.equal(unwrap(await invoke('online:status')).connection,'offline');
  const edit={customerId:seedId,expectedVersion:1,idempotencyKey:randomUUID(),companyName:'Offline Edited Company',contacts:[{contactId:1,email:'offline@example.invalid',name:'Alice'}]};unwrap(await invoke('online:customer-update',edit));
  unwrap(await invoke('online:followup',{customerId:seedId,expectedVersion:2,idempotencyKey:randomUUID(),note:'Offline persisted phone call',method:'phone'}));
  const created=unwrap(await invoke('online:customer-create',{companyName:'Created Offline',source:'fixture',sourceDetail:'',contacts:[{email:'created@example.invalid',name:'Created'}],idempotencyKey:randomUUID()}));
  unwrap(await invoke('online:followup',{customerId:created.customerId,expectedVersion:1,idempotencyKey:randomUUID(),note:'Created before reconnect',contactId:created.contacts[0].contactId,method:'phone'}));
  assert.equal(unwrap(await invoke('online:sync-status')).pending,4);
  await app.close();await launch();assert.equal(unwrap(await invoke('online:restore')).connection,'offline');
  await page.getByText('联系人',{exact:true}).first().waitFor();const local=unwrap(await invoke('online:detail',seedId));assert.equal(local.companyName,'Offline Edited Company');assert.equal(local.activities[0].note,'Offline persisted phone call');assert.equal(unwrap(await invoke('online:sync-status')).pending,4);
  await invoke('online:list',{view:'personal',search:'',limit:25,offset:0});await page.waitForTimeout(600);await page.screenshot({path:path.join(out,'offline-restart.png')});
  checks.push('offline restart keeps customers, contacts, followups and outbox');
  await start();assert.equal(unwrap(await invoke('online:status')).connection,'online');unwrap(await invoke('online:sync-now'));await waitSynced();assert.equal(customers.size,2);assert.equal(customers.get(seedId).activities.length,1);assert.equal(Array.from(customers.values()).find(c=>c.companyName==='Created Offline').activities.length,1);checks.push('reconnect replays dependencies with remapped IDs and no duplicates');
  await stop();unwrap(await invoke('online:status'));const latest=unwrap(await invoke('online:detail',seedId));unwrap(await invoke('online:followup',{customerId:seedId,expectedVersion:latest.version,idempotencyKey:randomUUID(),note:'Conflict stays local'}));customers.get(seedId).version++;await start();unwrap(await invoke('online:status'));unwrap(await invoke('online:sync-now'));const status=unwrap(await invoke('online:sync-status'));assert.equal(status.conflicts,1);assert.equal(unwrap(await invoke('online:detail',seedId)).activities[0].note,'Conflict stays local');checks.push('central version conflict retains local history');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].showInactive());await page.reload();const conflictStatus=unwrap(await invoke('online:sync-status'));assert.equal(conflictStatus.conflicts,1);await page.screenshot({path:path.join(out,'conflict.png')});await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].hide());
  unwrap(await invoke('online:logout'));currentIdentity={...identity,userId:randomUUID(),email:'other@example.invalid'};
  unwrap(await invoke('online:login',{baseUrl:base,email:currentIdentity.email,password:'SyntheticFixture2',remember:true}));unwrap(await invoke('online:bootstrap'));await waitSynced();
  await stop();unwrap(await invoke('online:status'));assert.equal(unwrap(await invoke('online:list',{view:'personal',search:'',limit:25,offset:0})).total,0);assert.equal((await invoke('online:detail',seedId)).ok,false);checks.push('second identity has a separate native SQLite database and cannot read prior account offline');
  assert.equal(errors.length,0,errors.join('\n'));writeFileSync(path.join(out,'report.json'),JSON.stringify({checks,pageErrors:errors,sandbox},null,2));console.log(JSON.stringify({checks,pageErrors:errors.length,sandbox},null,2));
})().catch(async error=>{if(page)console.error('PAGE',JSON.stringify({url:page.url(),body:(await page.locator('body').innerText().catch(()=>'' )).slice(0,3000),errors}));console.error(error.stack);process.exitCode=1;}).finally(async()=>{if(app)await app.close().catch(()=>{});if(center?.listening)await stop();});

