import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { NavigatorClient } from '../../src/main/services/navigator-auth.service';
import { pickImageName } from '../../src/main/services/rate-sync.service';

const repository = process.env.NAVIGATOR_TEST_REPO;
it.skipIf(!repository)('real Prospector client exchanges PKCE with Navigator, queries, refreshes, audits once, and rejects a disabled account', async () => {
  const child = spawn(process.env.NAVIGATOR_TEST_PYTHON || 'python', [path.resolve('tests/fixtures/navigator-http.py'), repository!], {stdio:['pipe','pipe','pipe']});
  const lines: string[] = [];
  let next: ((line:string)=>void) | null = null;
  createInterface({input:child.stdout}).on('line',line=>{ if(next){ const resolve=next;next=null;resolve(line);} else lines.push(line); });
  const read = () => lines.length ? Promise.resolve(lines.shift()!) : new Promise<string>(resolve=>{next=resolve;});
  const command = async (action:string) => {child.stdin.write(JSON.stringify({action})+'\n');return JSON.parse(await read());};
  try {
    const metadata = JSON.parse(await read());
    let refresh: string | null = null;
    const request = async (url:string,init:any) => {
      const response = await fetch(url, {...init,redirect:'error'});
      if (new URL(url).pathname.startsWith('/images/')) return {status:response.status,body:response.status === 200 ? `data:${response.headers.get('content-type')};base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}` : null};
      return {status:response.status,body:await response.json()};
    };
    const client = new NavigatorClient({baseUrl:()=>metadata.base,request,
      loadRefresh:async()=>refresh,saveRefresh:async(_base,value)=>{refresh=value;},clearRefresh:async()=>{refresh=null;},newQueryId:randomUUID,
      browserLogin:async base=>{
        const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'fixture-admin',password:metadata.password})});
        expect(login.status).toBe(200);
        const cookie=login.headers.get('set-cookie')!.split(';')[0]!;
        const verifier='integration-verifier-'.padEnd(64,'x');
        const redirectUri='http://127.0.0.1:43210/navigator/callback';
        const authorization=await request(base+'/api/prospector/authorize',{method:'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json'},body:JSON.stringify({client_id:'prospector',response_type:'code',redirect_uri:redirectUri,state:'integration-state',code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url')})});
        expect(authorization.status).toBe(200);
        const callback=new URL(authorization.body.data.redirect_url);
        expect(callback.searchParams.get('state')).toBe('integration-state');
        return {code:callback.searchParams.get('code')!,verifier,redirectUri};
      },
    });
    expect((await client.query({pod:'SANTOS'})).code).toBe('AUTH_REQUIRED');
    const login=await client.login();
    expect(login.data?.user?.name).toBe('fixture-admin');
    expect(await client.options()).toMatchObject({ok:true,data:{ports:expect.any(Array),carriers:expect.any(Array)}});
    const queryId=randomUUID();
    const result=await client.query({pod:'SANTOS',terms:['Brazil'],container:'40HQ',limit:1,offset:0},queryId);
    expect(result.ok).toBe(true);expect(result.data?.rows).toHaveLength(1);expect(result.data?.total).toBe(3);
    const imageName = pickImageName(result.data!.rows[0]!);
    expect(imageName).toBe('fixture-image-id-123_1_1.png');
    expect(await client.image(imageName!)).toMatchObject({ok:true,data:expect.stringMatching(/^data:image\/png;base64,/)});
    await client.query({pod:'SANTOS',limit:1,offset:1},queryId);
    await client.query({pod:'SANTOS'},queryId,'space');
    const events=await command('stats');
    expect(events).toHaveLength(1);expect(events[0].user_id).toBe(login.data?.user?.user_id);
    expect(JSON.parse(events[0].properties_json).client_app).toBe('prospector');
    expect(JSON.parse(events[0].properties_json).terms).toEqual(['Brazil']);
    expect(JSON.parse(events[0].properties_json).container).toBe('40HQ');
    const original=refresh;await command('expire');
    expect((await client.status()).data?.authenticated).toBe(true);expect(refresh).not.toBe(original);
    await command('disable');
    expect((await client.query({pod:'SANTOS'})).code).toBe('AUTH_REQUIRED');expect(refresh).toBeNull();
    expect((await client.logout()).ok).toBe(true);
  } finally {
    child.stdin.end(JSON.stringify({action:'exit'})+'\n');
    await new Promise<void>(resolve=>{if(child.exitCode!==null)resolve();else child.once('exit',()=>resolve());});
  }
}, 20000);
