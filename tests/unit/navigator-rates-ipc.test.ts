import { beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ handlers: new Map<string, (...args:any[])=>any>(), sync:vi.fn(), auto:vi.fn(), list:vi.fn(), login:vi.fn(), logout:vi.fn(), status:vi.fn(), image:vi.fn(), open:vi.fn() }));
vi.mock('electron',()=>({ipcMain:{handle:(channel:string,handler:any)=>fixture.handlers.set(channel,handler)},shell:{openExternal:fixture.open}}));
vi.mock('../../src/main/services/rate-sync.service',()=>({sync:fixture.sync,startAutoSync:fixture.auto,probeBoard:async()=>true,remoteBase:()=> 'http://obsolete.invalid',status:()=>({success:true,data:{total:999}}),listQuotes:()=>({success:true,data:[{oceanUsd:999}]})}));
vi.mock('../../src/main/adapters/navigator-quotes.adapter',()=>({listQuotes:fixture.list}));
vi.mock('../../src/main/adapters/navigator-auth.adapter',()=>({navigatorStatus:fixture.status,loginNavigator:fixture.login,logoutNavigator:fixture.logout,fetchNavigatorImage:fixture.image,fetchNavigatorOptions:fixture.status}));
import { registerRatesIPC } from '../../src/main/transport/rates.ipc';
import { IPC } from '../../src/main/contract';
beforeEach(()=>{vi.clearAllMocks();fixture.handlers.clear();registerRatesIPC();});
it('never starts an anonymous mirror and retires explicit full sync',async()=>{
 expect(fixture.auto).not.toHaveBeenCalled();
 expect(await fixture.handlers.get(IPC.RATES.SYNC)!(null)).toMatchObject({success:false});
 expect(fixture.sync).not.toHaveBeenCalled();
});
it('queries only the authenticated live service and routes authorization/image contracts',async()=>{
 fixture.list.mockResolvedValue({success:false,error:'请先登录'});
 expect(await fixture.handlers.get(IPC.RATES.LIST)!(null,{pod:'SANTOS'})).toMatchObject({success:false});
 expect(fixture.list).toHaveBeenCalledWith({pod:'SANTOS'});
 fixture.login.mockResolvedValue({ok:true,data:{authenticated:true}});
 expect(await fixture.handlers.get(IPC.RATES.NAVIGATOR_LOGIN)!(null)).toMatchObject({ok:true});
 fixture.image.mockResolvedValue({ok:false,error:'请先登录'});
 expect(await fixture.handlers.get(IPC.RATES.IMAGE)!(null,'quote.png')).toMatchObject({ok:false});
});
it('opens the configured Navigator rather than the legacy mirror URL',async()=>{
 fixture.status.mockResolvedValue({ok:true,data:{authenticated:false,baseUrl:'https://navigator.example'}});
 expect(await fixture.handlers.get(IPC.RATES.OPEN_BOARD)!(null)).toMatchObject({success:true});
 expect(fixture.open).toHaveBeenCalledWith('https://navigator.example');
});
