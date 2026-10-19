import {beforeEach,describe,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({handlers:new Map<string,(...args:unknown[])=>unknown>(),list:vi.fn()}));
vi.mock('electron',()=>({ipcMain:{handle:(channel:string,handler:(...args:unknown[])=>unknown)=>state.handlers.set(channel,handler)}}));
vi.mock('../../src/main/services/crm.service',()=>({listPipeline:state.list}));
import {registerCrmIPC} from '../../src/main/transport/crm.ipc';
import {IPC} from '../../src/main/contract';
describe('legacy board preserves reached-only CRM service contract',()=>{
 beforeEach(()=>{state.list.mockReset();state.handlers.clear();registerCrmIPC();});
 it('does not introduce a management-role restriction into the reached-only query',async()=>{
  const result={success:true,data:[]};state.list.mockResolvedValue(result);
  expect(await state.handlers.get(IPC.CRM.LIST_PIPELINE)!()).toEqual(result);
  expect(state.list).toHaveBeenCalledOnce();
 });
});
