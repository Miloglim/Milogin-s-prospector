import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { createServer,type Server } from 'node:http';
import { createTaskHandler } from '../../server/transport/tasks-http';
import { createTaskService } from '../../server/services/tasks';
import { success } from '../../server/core/crm';
import type { TaskRepository } from '../../server/core/tasks';
const ID='00000000-0000-0000-0000-000000000001',OTHER='00000000-0000-0000-0000-000000000002',TOKEN='a'.repeat(43);
describe('task HTTP routing through service validation',()=>{
 let server:Server,base:string,repo:TaskRepository;
 beforeEach(async()=>{
  repo={create:vi.fn().mockResolvedValue(success({taskId:ID})),list:vi.fn().mockResolvedValue(success({items:[],total:0})),detail:vi.fn().mockResolvedValue(success({taskId:ID})),reschedule:vi.fn().mockResolvedValue(success({taskId:ID})),complete:vi.fn().mockResolvedValue(success({taskId:ID})),processDue:vi.fn()};
  const handler=createTaskHandler(createTaskService(repo,{hash:()=> 'session-hash'} as never));
  server=createServer((req,res)=>{void handler(req,res);});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 });
 afterEach(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
 async function request(path:string,input?:unknown,token=TOKEN){const response=await fetch(base+path,{method:input===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,...(input===undefined?{}:{'Content-Type':'application/json'})},...(input===undefined?{}:{body:JSON.stringify(input)})});return {status:response.status,json:await response.json()};}
 it('preserves immutable IDs and retry keys in all mutation routes',async()=>{
  const create={customerId:ID,title:'Call',dueAt:'2026-10-13T10:00:00+08:00',expectedCustomerVersion:2,idempotencyKey:'same-create-key'};
  expect((await request('/api/crm/tasks',create)).status).toBe(200);expect(repo.create).toHaveBeenCalledWith('session-hash',create);
  const reschedule={expectedVersion:2,idempotencyKey:'same-postpone-key',dueAt:'2099-01-01T00:00:00Z'};
  expect((await request(`/api/crm/tasks/${ID}/reschedule`,reschedule)).status).toBe(200);expect(repo.reschedule).toHaveBeenCalledWith('session-hash',{...reschedule,taskId:ID});
  const complete={taskId:ID,expectedVersion:3,idempotencyKey:'same-complete-key',feedback:'Done'};
  expect((await request(`/api/crm/tasks/${ID}/complete`,complete)).status).toBe(200);expect(repo.complete).toHaveBeenCalledWith('session-hash',complete);
 });
 it('maps list and detail and rejects invalid paging/status/customer filters',async()=>{
  expect((await request(`/api/crm/tasks?customerId=${ID}&status=open&limit=10&offset=20`)).status).toBe(200);
  expect(repo.list).toHaveBeenCalledWith('session-hash',{customerId:ID,status:'open',limit:10,offset:20});
  expect((await request(`/api/crm/tasks/${ID}`)).status).toBe(200);expect(repo.detail).toHaveBeenCalledWith('session-hash',ID);
  for(const path of ['/api/crm/tasks?limit=101','/api/crm/tasks?offset=-1','/api/crm/tasks?status=pending','/api/crm/tasks?customerId=bad'])expect((await request(path)).status).toBe(400);
  expect(repo.list).toHaveBeenCalledTimes(1);
 });
 it('rejects conflicting path/body ID, unknown fields and malformed completion before repository IO',async()=>{
  const command={taskId:OTHER,expectedVersion:1,idempotencyKey:'key',feedback:'Done'};
  expect((await request(`/api/crm/tasks/${ID}/complete`,command)).status).toBe(400);
  expect((await request(`/api/crm/tasks/${ID}/complete`,{...command,taskId:ID,unexpected:true})).status).toBe(400);
  expect((await request(`/api/crm/tasks/${ID}/complete`,[])).status).toBe(400);
  expect((await request(`/api/crm/tasks/${ID}/complete`,{...command,taskId:ID,feedback:''})).status).toBe(400);
  expect(repo.complete).not.toHaveBeenCalled();
 });
 it('rejects absent bearer and unknown actions and bounds body size',async()=>{
  expect((await request('/api/crm/tasks',undefined,'')).status).toBe(401);expect(repo.list).not.toHaveBeenCalled();
  expect((await request(`/api/crm/tasks/${ID}/cancel`,{})).status).toBe(404);
  expect((await request(`/api/crm/tasks/${ID}/complete/extra`,{})).status).toBe(404);
  expect((await request('/api/crm/tasks',{title:'x'.repeat(1048576)})).status).toBe(413);expect(repo.create).not.toHaveBeenCalled();
 });
});
