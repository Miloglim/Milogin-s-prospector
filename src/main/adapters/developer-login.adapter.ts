import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { OnlineLogin } from '../../shared/online-crm';
const DEV_ROLES = { operations: 'agent-admin@example.invalid', sales: 'agent-user@example.invalid' } as const;
const HEALTH_TIMEOUT_MS = 5000;
const TEST_CENTER_PORT = 55844;
/** Real credentials from the owned test runtime; never fabricates an authenticated actor. */
export async function developmentLogin(packaged:boolean,profile:string|null):Promise<OnlineLogin|null> {
  const role=process.env.PROSPECTOR_DEV_AUTOLOGIN;
  if(packaged || !profile || !role || !Object.hasOwn(DEV_ROLES,role))return null;
  // Auto-login seeds only a fresh profile. Restart after logout must remain logged out.
  const binding=JSON.parse(await readFile(resolve(profile,'desktop-local-binding.json'),'utf8'));
  if(binding.version!==1 || binding.owner!==null)return null;
  const runtime=resolve(__dirname,'../..','.work/pg-crm');
  const config=JSON.parse(await readFile(resolve(runtime,'online.json'),'utf8'));
  const state=JSON.parse(await readFile(resolve(runtime,'online-process.json'),'utf8'));
  if(config.test_mode!==true || config.host!=='127.0.0.1' || config.port!==TEST_CENTER_PORT || state.marker!=='prospector-online-instance-v1')throw new Error('开发自动登录只允许受控本机测试中心');
  const baseUrl=`http://${config.host}:${config.port}`;
  const live=await fetch(`${baseUrl}/health/live`,{redirect:'error',signal:AbortSignal.timeout(HEALTH_TIMEOUT_MS)}).then(r=>r.json());
  if(!live.ok || live.data?.instanceId!==state.instanceId)throw new Error('测试中心进程身份不匹配');
  const fixtures=JSON.parse(await readFile(resolve(runtime,'online-fixtures.json'),'utf8'));
  if(fixtures.marker!=='prospector-online-fixtures-v1' || !Array.isArray(fixtures.accounts))throw new Error('开发账号夹具无效');
  const email=DEV_ROLES[role as keyof typeof DEV_ROLES];
  const account=fixtures.accounts.find((value:{email:string})=>value.email===email);
  if(!account || typeof account.password!=='string')throw new Error('开发账号未准备');
  return {baseUrl,email,password:account.password,remember:true};
}
