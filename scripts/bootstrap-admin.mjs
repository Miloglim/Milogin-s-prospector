// Local one-time initialization. Password comes from stdin/environment, never from source or logs.
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
const require=createRequire(import.meta.url);
const {Pool}=require('pg');
const {readTestDatabaseConfig}=require('../dist-server/adapters/postgres/config.js');
const {PostgresAuthRepository}=require('../dist-server/adapters/postgres/auth-repository.js');
const {PasswordAdapter}=require('../dist-server/adapters/password.js');
const {BOOTSTRAP_ADMIN_EMAIL,BOOTSTRAP_LOGIN_MIN,AUTH_LIMITS}=require('../dist-server/core/auth.js');
const {capabilitiesFor}=require('../dist-server/core/admin.js');
const {ADMIN_LOCK}=require('../dist-server/adapters/postgres/admin-schema.js');
const MARKER='.work/pg-crm/admin-bootstrap.json',FIXTURES='.work/pg-crm/online-fixtures.json',PRIVATE_MODE=0o600,INDENT=2;
const log={write:(level,context,message)=>process.stdout.write(`[${new Date().toISOString()}] [${level}] [${context}] ${message}\n`)};
function recordInitialized(id){
 if(fs.existsSync(FIXTURES)){const file=JSON.parse(fs.readFileSync(FIXTURES,'utf8'));const account=file.accounts.find(a=>a.userId===id);if(account)account.email=BOOTSTRAP_ADMIN_EMAIL;fs.writeFileSync(FIXTURES,JSON.stringify(file,null,INDENT),{mode:PRIVATE_MODE});}
 if(!fs.existsSync(MARKER))fs.writeFileSync(MARKER,JSON.stringify({marker:'prospector-admin-bootstrap-v1',email:BOOTSTRAP_ADMIN_EMAIL,userId:id},null,INDENT),{mode:PRIVATE_MODE,flag:'wx'});
}
async function main(){
 if(!process.argv.includes('--test'))throw Error('Explicit local test mode required');
 const pool=new Pool(readTestDatabaseConfig());
 try{
  const repo=new PostgresAuthRepository(pool,log);if(!(await repo.migrate()).ok)throw Error('Migration rejected');
  const initialized=await pool.query("SELECT e.user_id FROM identity.login_emails e WHERE e.email=$1 AND EXISTS(SELECT 1 FROM identity.management_audit a WHERE a.target_id=e.user_id AND a.action='identity.bootstrap')",[BOOTSTRAP_ADMIN_EMAIL]);
  if(initialized.rows.length){recordInitialized(initialized.rows[0].user_id);log.write('INFO','identity.bootstrap','初始化已执行；保留当前密码与权限，不重复重置');return;}
  if(fs.existsSync(MARKER))throw Error('Bootstrap identity does not match local record');
  let password=process.env.PROSPECTOR_ADMIN_INITIAL_PASSWORD;
  if(!password){
   if(process.stdin.isTTY)process.stdin.setRawMode(true); // Secure local input: no terminal echo.
   const reader=createInterface({input:process.stdin,terminal:false});
   password=await new Promise((resolve,reject)=>{let received=false;reader.once('line',line=>{received=true;resolve(line);reader.close();});reader.once('close',()=>{if(!received)reject(Error('Initial password not supplied'));});});
   if(process.stdin.isTTY)process.stdin.setRawMode(false);
  }
  if(typeof password!=='string'||password.length<BOOTSTRAP_LOGIN_MIN||password.length>AUTH_LIMITS.passwordMax)throw Error('Invalid initial password');
  const crypto=new PasswordAdapter(1);await crypto.initialize();const hash=await crypto.hash(password);password=undefined;delete process.env.PROSPECTOR_ADMIN_INITIAL_PASSWORD;
  const client=await pool.connect();let id;
  try{
   await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock($1)',[ADMIN_LOCK]);
   const done=await client.query("SELECT e.user_id FROM identity.login_emails e WHERE e.email=$1 AND EXISTS(SELECT 1 FROM identity.management_audit a WHERE a.target_id=e.user_id AND a.action='identity.bootstrap')",[BOOTSTRAP_ADMIN_EMAIL]);
   if(done.rows.length){
    id=done.rows[0].user_id;await client.query('COMMIT');recordInitialized(id);log.write('INFO','identity.bootstrap','另一初始化已完成，保留当前密码与权限');return;
   }
   const users=await client.query('SELECT user_id,email FROM identity.login_emails WHERE email=ANY($1::text[])',[['admin@example.invalid',BOOTSTRAP_ADMIN_EMAIL]]);
   if(users.rows.length>1)throw Error('Do not merge existing identities');
   id=users.rows[0]?.user_id??randomUUID();
   if(!users.rows.length){await client.query("INSERT INTO identity.users(user_id,display_name,identity_admin,must_change_password) VALUES($1,'Milogin 管理员',true,true)",[id]);await client.query('INSERT INTO identity.login_emails(user_id,email) VALUES($1,$2)',[id,BOOTSTRAP_ADMIN_EMAIL]);}
   else{await client.query('UPDATE identity.login_emails SET email=$2,verified_at=NULL WHERE user_id=$1',[id,BOOTSTRAP_ADMIN_EMAIL]);await client.query("UPDATE identity.users SET display_name='Milogin 管理员',active=true,identity_admin=true,must_change_password=true,security_revision=security_revision+1,management_revision=management_revision+1 WHERE user_id=$1",[id]);}
   await client.query("INSERT INTO identity.credentials(user_id,password_hash,hash_scheme) VALUES($1,$2,'scrypt-v1') ON CONFLICT(user_id) DO UPDATE SET password_hash=EXCLUDED.password_hash,changed_at=now()",[id,hash]);
   await client.query('DELETE FROM identity.product_grants WHERE user_id=$1',[id]);const roles=['admin','operations','sales','auditor'];for(const role of roles)await client.query("INSERT INTO identity.product_grants(user_id,product_id,role) VALUES($1,'crm',$2)",[id,role]);
   await client.query("INSERT INTO identity.product_access(user_id,product_id,active,scope,capabilities) VALUES($1,'crm',true,'summary',$2) ON CONFLICT(user_id,product_id) DO UPDATE SET active=true,scope='summary',capabilities=EXCLUDED.capabilities",[id,JSON.stringify(capabilitiesFor(roles))]);
   await client.query('UPDATE identity.sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',[id]);await client.query('UPDATE identity.management_challenges SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL',[id]);
   await client.query("INSERT INTO identity.management_audit(actor_id,target_id,action,reason) VALUES($1,$1,'identity.bootstrap','本机一次性管理员初始化，首次登录必须改密')",[id]);
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  recordInitialized(id);
  log.write('INFO','identity.bootstrap','最高管理员初始化完成；初始密码仅用于进入强制改密页');
 }finally{await pool.end();}
}
void main().catch(()=>{log.write('ERROR','identity.bootstrap','初始化未完成；检查本机配置/身份冲突，不要粘贴密码');process.exitCode=1;});
