import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool, type PoolClient } from 'pg';
import { readTestDatabaseConfig } from '../../server/adapters/postgres/config';
import { PostgresAdminRepository } from '../../server/adapters/postgres/admin-repository';
import { PostgresAuthRepository } from '../../server/adapters/postgres/auth-repository';
import { USER_LIFECYCLE_SQL } from '../../server/adapters/postgres/user-lifecycle-schema';
import type { ChallengeDraft } from '../../server/core/admin';

const enabled=process.env.PROSPECTOR_LIFECYCLE_TEST==='1';
describe.skipIf(!enabled)('user lifecycle PostgreSQL rollback-only verification',()=>{
 let pool:Pool,c:PoolClient,repo:PostgresAdminRepository,actorId:string,hash:string;
 const logs:string[]=[];
 beforeEach(async()=>{
  pool=new Pool(readTestDatabaseConfig());c=await pool.connect();await c.query('BEGIN');
  const column=await c.query("SELECT 1 FROM information_schema.columns WHERE table_schema='identity' AND table_name='users' AND column_name='deleted_at'");
  if(!column.rows.length)await c.query(USER_LIFECYCLE_SQL);
  actorId=JSON.parse(readFileSync('.work/pg-crm/online-fixtures.json','utf8')).accounts.find((x:any)=>x.email==='agent-admin@example.invalid').userId;
  await c.query('UPDATE identity.users SET identity_admin=true,active=true,must_change_password=false WHERE user_id=$1',[actorId]);
  hash=createHash('sha256').update(randomUUID()).digest('hex');
  await c.query("INSERT INTO identity.sessions(token_hash,user_id,security_revision,expires_at,client) SELECT $1,user_id,security_revision,now()+interval '1 hour','browser' FROM identity.users WHERE user_id=$2",[hash,actorId]);
  // The repository's transactions become savepoints inside an outer rollback.
  // No successful mutation can commit test accounts into the shared database.
  const wrapped={options:pool.options,connect:async()=>({release:()=>{},query:async(sql:string,params?:any[])=>{
   if(sql==='BEGIN')return c.query('SAVEPOINT lifecycle_operation');
   if(sql==='COMMIT')return c.query('RELEASE SAVEPOINT lifecycle_operation');
   if(sql==='ROLLBACK'){await c.query('ROLLBACK TO SAVEPOINT lifecycle_operation');return c.query('RELEASE SAVEPOINT lifecycle_operation');}
   if(sql.startsWith('SET TRANSACTION'))return {rows:[]}; // outer transaction owns isolation
   return c.query(sql,params);
  }})};
  repo=new PostgresAdminRepository(wrapped as any,{write:(_level,_context,message)=>logs.push(message)});
 });
 afterEach(async()=>{if(c){await c.query('ROLLBACK');c.release();}if(pool)await pool.end();expect(logs.splice(0)).toEqual([]);});
 async function target(active=true){
  const id=randomUUID(),email=`lifecycle-${id}@example.invalid`;
  await c.query('INSERT INTO identity.users(user_id,display_name,active) VALUES($1,$2,$3)',[id,'Rollback-only account',active]);
  await c.query('INSERT INTO identity.login_emails(user_id,email) VALUES($1,$2)',[id,email]);
  if(active)await c.query("INSERT INTO identity.credentials(user_id,password_hash,hash_scheme) VALUES($1,'synthetic-hash','scrypt-v1')",[id]);
  return {id,email};
 }
 function challenge(id:string,email:string,purpose:'activate'|'recover'='recover'):ChallengeDraft{return {userId:id,email,displayName:'New account',purpose,tokenHash:createHash('sha256').update(randomUUID()).digest('hex'),expiresAt:new Date(Date.now()+600000).toISOString()};}
 it('creates active role-selected users with mandatory password change and rejects duplicate identities',async()=>{
  for(const role of ['operations','sales','admin'] as const){
   const email=`initial-${randomUUID()}@example.invalid`;
   const command={action:'user.create' as const,email,role,reason:'rollback test'};
   expect((await repo.mutate(hash,command,undefined,'synthetic-initial-hash')).ok).toBe(true);
   expect((await repo.mutate(hash,command,undefined,'synthetic-initial-hash')).ok).toBe(false);
   const row=(await c.query('SELECT u.user_id,u.active,u.must_change_password,u.identity_admin,c.password_hash FROM identity.users u JOIN identity.login_emails e USING(user_id) JOIN identity.credentials c USING(user_id) WHERE e.email=$1',[email])).rows[0];
   expect(row.active).toBe(true);expect(row.must_change_password).toBe(true);expect(row.identity_admin).toBe(role==='admin');
   const grants=(await c.query('SELECT role FROM identity.product_grants WHERE user_id=$1',[row.user_id])).rows.map(x=>x.role);
   expect(grants).toContain(role);expect(row.password_hash).toBe('synthetic-initial-hash');
  }
 });
 it('reissues only pending identities, retires old links and activates once without granting privileges',async()=>{
  const email=`lifecycle-${randomUUID()}@example.invalid`,draft=challenge('',email,'activate');
  const command={action:'challenge.issue' as const,email,displayName:'New account',purpose:'activate' as const,reason:'rollback test'};
  expect((await repo.mutate(hash,command,draft)).ok).toBe(true);
  const reissued=challenge('',email,'activate');expect((await repo.mutate(hash,command,reissued)).ok).toBe(true);
  expect((await repo.consume(draft.tokenHash,'synthetic-hash')).ok).toBe(false);
  expect((await repo.consume(reissued.tokenHash,'synthetic-hash')).ok).toBe(true);
  expect((await repo.consume(reissued.tokenHash,'other-hash')).ok).toBe(false);
  expect((await repo.mutate(hash,command,challenge('',email,'activate'))).ok).toBe(false);
  const row=(await c.query('SELECT u.active,u.identity_admin FROM identity.users u JOIN identity.login_emails e USING(user_id) WHERE e.email=$1',[email])).rows[0];
  expect(row).toEqual({active:true,identity_admin:false});
 });
 it('rejects activation reissue for credentialed disabled and deleted identities',async()=>{
  const t=await target();await c.query('UPDATE identity.users SET active=false WHERE user_id=$1',[t.id]);
  const command={action:'challenge.issue' as const,email:t.email,displayName:'Existing account',purpose:'activate' as const,reason:'rollback test'};
  expect(await repo.mutate(hash,command,challenge(t.id,t.email,'activate'))).toMatchObject({error:{code:'CONFLICT'}});
  await c.query('DELETE FROM identity.credentials WHERE user_id=$1',[t.id]);await c.query('UPDATE identity.users SET deleted_at=now() WHERE user_id=$1',[t.id]);
  expect(await repo.mutate(hash,command,challenge(t.id,t.email,'activate'))).toMatchObject({error:{code:'CONFLICT'}});
 });
 it('reset is account-bound, revokes sessions immediately and changes password once',async()=>{
  const t=await target(),draft=challenge(t.id,t.email);
  await c.query("INSERT INTO identity.sessions(token_hash,user_id,security_revision,expires_at) VALUES($1,$2,1,now()+interval '1 hour')",['b'.repeat(64),t.id]);
  expect((await repo.mutate(hash,{action:'user.reset-password',userId:t.id,revision:1,reason:'reset test'},draft)).ok).toBe(true);
  expect((await c.query('SELECT revoked_at IS NOT NULL AS revoked FROM identity.sessions WHERE user_id=$1',[t.id])).rows[0].revoked).toBe(true);
  expect((await repo.consume(draft.tokenHash,'new-synthetic-hash')).ok).toBe(true);
  expect((await repo.consume(draft.tokenHash,'again')).ok).toBe(false);
  expect((await c.query('SELECT password_hash FROM identity.credentials WHERE user_id=$1',[t.id])).rows[0].password_hash).toBe('new-synthetic-hash');
 });
 it('soft deletion hides identity, retains email/audit, rejects reactivation and invalidates reset links',async()=>{
  const t=await target(),draft=challenge(t.id,t.email);
  expect((await repo.mutate(hash,{action:'user.reset-password',userId:t.id,revision:1,reason:'reset'},draft)).ok).toBe(true);
  expect((await repo.mutate(hash,{action:'user.delete',userId:t.id,revision:2,reason:'departed'})).ok).toBe(true);
  const row=(await c.query('SELECT active,deleted_at IS NOT NULL AS deleted FROM identity.users WHERE user_id=$1',[t.id])).rows[0];expect(row).toEqual({active:false,deleted:true});
  const page=await repo.users(hash,{search:t.email,limit:25,offset:0});expect(page.ok&&page.data.total).toBe(0);
  await c.query("INSERT INTO identity.sessions(token_hash,user_id,security_revision,expires_at,client) SELECT $1,user_id,security_revision,now()+interval '1 hour','api' FROM identity.users WHERE user_id=$2",['c'.repeat(64),actorId]);
  const authRepo=new PostgresAuthRepository({options:pool.options,on:()=>{},query:c.query.bind(c)} as any,{write:(_level,_context,message)=>logs.push(message)});
  const directory=await authRepo.listUsers('c'.repeat(64));expect(directory.ok).toBe(true);
  if(directory.ok)expect(directory.data.some(user=>user.userId===t.id)).toBe(false);
  expect((await c.query('SELECT email FROM identity.login_emails WHERE user_id=$1',[t.id])).rows).toHaveLength(1);
  expect((await c.query("SELECT 1 FROM identity.management_audit WHERE target_id=$1 AND action='user.delete'",[t.id])).rows).toHaveLength(1);
  expect((await repo.consume(draft.tokenHash,'bad')).ok).toBe(false);
  expect((await repo.mutate(hash,{action:'user.update',userId:t.id,revision:3,active:true,identityAdmin:false,reason:'reactivate'})).ok).toBe(false);
 });
 it('sorts users by permission priority before creation time',async()=>{
  const prefix=`sort-${randomUUID()}`;
  const users=[
   {key:'none',identityAdmin:false,role:null},
   {key:'auditor',identityAdmin:false,role:'auditor'},
   {key:'sales',identityAdmin:false,role:'sales'},
   {key:'operations',identityAdmin:false,role:'operations'},
   {key:'crm-admin',identityAdmin:false,role:'admin'},
   {key:'identity-admin',identityAdmin:true,role:'sales'},
  ] as const;
  for(const user of users){
   const id=randomUUID(),email=`${prefix}-${user.key}@example.invalid`;
   await c.query('INSERT INTO identity.users(user_id,display_name,active,identity_admin) VALUES($1,$2,true,$3)',[id,user.key,user.identityAdmin]);
   await c.query('INSERT INTO identity.login_emails(user_id,email) VALUES($1,$2)',[id,email]);
   if(user.role)await c.query("INSERT INTO identity.product_grants(user_id,product_id,role,active) VALUES($1,'crm',$2,true)",[id,user.role]);
  }
  const page=await repo.users(hash,{search:prefix,limit:25,offset:0});
  expect(page.ok).toBe(true);
  if(page.ok)expect(page.data.items.map(user=>user.email)).toEqual(
   ['identity-admin','crm-admin','operations','sales','auditor','none'].map(key=>`${prefix}-${key}@example.invalid`),
  );
 });
 it('blocks stale revisions, self deletion and deletion of an owner',async()=>{
  const t=await target();
  expect((await repo.mutate(hash,{action:'user.delete',userId:t.id,revision:99,reason:'stale'})).ok).toBe(false);
  const revision=(await c.query('SELECT management_revision FROM identity.users WHERE user_id=$1',[actorId])).rows[0].management_revision;
  expect((await repo.mutate(hash,{action:'user.delete',userId:actorId,revision,reason:'self'})).ok).toBe(false);
  const company=(await c.query("INSERT INTO companies(name) VALUES('Rollback test') RETURNING id")).rows[0].id;
  await c.query("INSERT INTO crm_customers(company_id,source,customer_key,source_detail,state,owner_user_id,created_by,origin) VALUES($1,'test',$2,'test','owned',$3,$4,'personal')",[company,randomUUID(),t.id,actorId]);
  const result=await repo.mutate(hash,{action:'user.delete',userId:t.id,revision:1,reason:'owner'});
  expect(result.ok).toBe(false);if(!result.ok)expect(result.error.message).toContain('转交');
  expect((await c.query('SELECT active FROM identity.users WHERE user_id=$1',[t.id])).rows[0].active).toBe(true);
 });
 it('blocks ordinary administrators and protects the last credentialed super administrator',async()=>{
  const t=await target();
  await c.query('UPDATE identity.users SET identity_admin=false WHERE user_id=$1',[actorId]);
  expect((await repo.mutate(hash,{action:'user.create',email:`denied-${randomUUID()}@example.invalid`,role:'admin',reason:'forbidden'},undefined,'synthetic-hash')).ok).toBe(false);
  expect((await repo.mutate(hash,{action:'user.delete',userId:t.id,revision:1,reason:'forbidden'})).ok).toBe(false);
  await c.query('UPDATE identity.users SET active=false WHERE identity_admin');
  await c.query('UPDATE identity.users SET identity_admin=true,active=true WHERE user_id=ANY($1::uuid[])',[[actorId,t.id]]);
  await c.query('DELETE FROM identity.credentials WHERE user_id=$1',[actorId]);
  const result=await repo.mutate(hash,{action:'user.delete',userId:t.id,revision:1,reason:'last'});
  expect(result.ok).toBe(false);if(!result.ok)expect(result.error.message).toContain('至少一名');
 });
});
