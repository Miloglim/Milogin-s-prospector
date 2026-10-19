import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({handlers:new Map<string,(event:unknown,input:any)=>Promise<any>>(),snapshot:vi.fn(),search:vi.fn(),generate:vi.fn(),save:vi.fn()}));
vi.mock('electron',()=>({ipcMain:{handle:(name:string,fn:any)=>mocks.handlers.set(name,fn)}}));
vi.mock('../../src/main/services/agent-contact.service',()=>({getAgentContactPort:()=>({snapshot:mocks.snapshot})}));
vi.mock('../../src/main/services/ai.service',()=>({searchCompany:mocks.search,generateBackcheckReport:mocks.generate}));
vi.mock('../../src/main/services/company.service',()=>({saveBackcheck:mocks.save,getBackcheckReport:vi.fn()}));
vi.mock('../../src/main/services/provider.service',()=>({}));
vi.mock('../../src/main/net-proxy',()=>({}));
vi.mock('../../src/main/logger',()=>({Log:{debug:vi.fn()}}));
import { registerAiIPC } from '../../src/main/transport/ai.ipc';
import { IPC } from '../../src/main/contract';

const reference={contactId:7,customerId:'12345678-1234-1234-1234-123456789abc'};
beforeEach(()=>{vi.clearAllMocks();mocks.handlers.clear();registerAiIPC();mocks.search.mockResolvedValue({success:true,data:[]});mocks.generate.mockResolvedValue({success:true,data:{summary:'Synthetic report'}});});
describe('center backcheck authorization',()=>{
 it('allows a read-only shared mail collaborator to generate without any company write',async()=>{
  mocks.snapshot.mockReturnValue({ok:true,data:{active:()=>true,contacts:[{...reference,companyId:4,isShared:true,canEdit:false,canFollowup:false,canSendMail:true}]}});
  expect(await mocks.handlers.get(IPC.AI.BACKCHECK)!(null,{companyName:'Synthetic',centerReference:reference})).toMatchObject({success:true,data:{companyId:4,report:{summary:'Synthetic report'}}});
  expect(mocks.search).toHaveBeenCalledTimes(1);expect(mocks.generate).toHaveBeenCalledTimes(1);expect(mocks.save).not.toHaveBeenCalled();
 });
 it('denies a known read-only contact without development rights before running research',async()=>{
  mocks.snapshot.mockReturnValue({ok:true,data:{active:()=>true,contacts:[{...reference,companyId:4,isShared:true,canEdit:false,canFollowup:false,canSendMail:false}]}});
  expect(await mocks.handlers.get(IPC.AI.BACKCHECK)!(null,{companyName:'Synthetic',centerReference:reference})).toMatchObject({success:false});
  expect(mocks.search).not.toHaveBeenCalled();expect(mocks.generate).not.toHaveBeenCalled();expect(mocks.save).not.toHaveBeenCalled();
 });
});
