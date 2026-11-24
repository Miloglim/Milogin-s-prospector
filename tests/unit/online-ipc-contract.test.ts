import {describe,it,expect,vi} from 'vitest';
const registered=vi.hoisted(()=>new Map<string,(event:unknown,...args:unknown[])=>Promise<unknown>>());
vi.mock('electron',()=>({ipcMain:{handle:vi.fn((channel:string,handler:(event:unknown,...args:unknown[])=>Promise<unknown>)=>{if(registered.has(channel))throw new Error('duplicate');registered.set(channel,handler);})},dialog:{},app:{getPath:()=>'/synthetic'},safeStorage:{isEncryptionAvailable:()=>false}}));
vi.mock('../../src/main/logger',()=>({Log:{error:vi.fn(),warn:vi.fn()}}));
import {registerOnlineCrmIPC} from '../../src/main/transport/online-crm.ipc';
import {IPC} from '../../src/main/contract';
import {ONLINE_CHANNELS} from '../../src/shared/online-crm';
describe('one shared online IPC contract',()=>{
  it('registers every declared channel exactly once, including global status/restore/password',async()=>{
    registerOnlineCrmIPC();expect([...registered.keys()].sort()).toEqual(Object.values(ONLINE_CHANNELS).sort());
    expect(registered.size).toBe(Object.values(ONLINE_CHANNELS).length);
    expect(IPC.ONLINE).toBe(ONLINE_CHANNELS);
    const state=await registered.get(ONLINE_CHANNELS.STATUS)!(undefined) as any;
    expect(state).toEqual({ok:true,data:{identity:null,remembered:false,baseUrl:'http://127.0.0.1:55847',localAvailable:false,connection:'online'}});
    expect(JSON.stringify(state)).not.toMatch(/refreshToken|password|bearer/);
  });
});
