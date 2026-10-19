import {afterEach,describe,it,expect,vi} from 'vitest';
const state=vi.hoisted(()=>({owner:null as null|{userId:string},read:vi.fn()}));
vi.mock('node:fs/promises',()=>({readFile:state.read}));
import {developmentLogin} from '../../src/main/adapters/developer-login.adapter';
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();state.read.mockReset();state.owner=null;});
describe('developer convenience cannot resurrect a logged-out profile',()=>{
  it('does not activate in a packaged process',async()=>{vi.stubEnv('PROSPECTOR_DEV_AUTOLOGIN','operations');expect(await developmentLogin(true,'/synthetic')).toBeNull();expect(state.read).not.toHaveBeenCalled();});
  it('does not auto-login an already bound profile even if the environment survives relaunch',async()=>{vi.stubEnv('PROSPECTOR_DEV_AUTOLOGIN','sales');state.read.mockResolvedValue(JSON.stringify({version:1,owner:{userId:'bound'}}));expect(await developmentLogin(false,'/synthetic')).toBeNull();expect(state.read).toHaveBeenCalledTimes(1);});
  it('uses real fixture credentials only after proving the owned test center',async()=>{
    vi.stubEnv('PROSPECTOR_DEV_AUTOLOGIN','sales');
    state.read.mockImplementation(async(file:string)=>JSON.stringify(file.endsWith('desktop-local-binding.json')?{version:1,owner:null}:file.endsWith('online.json')?{test_mode:true,host:'127.0.0.1',port:55844}:file.endsWith('online-process.json')?{marker:'prospector-online-instance-v1',instanceId:'owned-test'}:{marker:'prospector-online-fixtures-v1',accounts:[{email:'agent-user@example.invalid',password:'synthetic-fixture-password'}]}));
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({ok:true,data:{instanceId:'owned-test'}}))));
    expect(await developmentLogin(false,'/synthetic')).toEqual({baseUrl:'http://127.0.0.1:55844',email:'agent-user@example.invalid',password:'synthetic-fixture-password',remember:true});
  });
});

