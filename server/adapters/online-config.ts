import { readFileSync } from "node:fs";
import path from "node:path";
import { ONLINE_DEFAULTS, type OnlineConfig } from "../core/auth";
export const ONLINE_CONFIG_PATH = ".work/pg-crm/online.json";
const PORT_MAX = 65535;
const SESSION_TTL_MAX_SECONDS = 86400;
const PRODUCTION_HTTP_PORT = 55847;
const PRODUCTION_RUNTIME_DIRECTORY = "MiloginCenter";
export function onlineRuntimeDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PROSPECTOR_CENTER_MODE === 'production') {
    return path.join(env.ProgramData || 'C:\\ProgramData', PRODUCTION_RUNTIME_DIRECTORY);
  }
  if (env.PROSPECTOR_CENTER_MODE && env.PROSPECTOR_CENTER_MODE !== 'test') throw new Error('未知中心运行模式');
  return path.dirname(ONLINE_CONFIG_PATH);
}
export function readOnlineConfig(env: NodeJS.ProcessEnv = process.env): OnlineConfig {
  if (env.PROSPECTOR_CENTER_MODE === 'production') {
    const origin = env.PROSPECTOR_CENTER_PUBLIC_ORIGIN;
    if (!origin) throw new Error('正式中心缺少 HTTPS 对外地址');
    let parsed: URL;
    try { parsed = new URL(origin); }
    catch { throw new Error('正式中心 HTTPS 对外地址无效'); }
    if (parsed.protocol !== 'https:' || parsed.origin !== origin || parsed.username || parsed.password) {
      throw new Error('正式中心只接受 HTTPS 对外地址');
    }
    const navigatorUrl = env.PROSPECTOR_NAVIGATOR_URL || ONLINE_DEFAULTS.navigator_url;
    const navigatorEntryUrl = env.PROSPECTOR_NAVIGATOR_ENTRY_URL || navigatorUrl;
    for (const candidate of [navigatorUrl, navigatorEntryUrl]) {
      try { const parsedNavigator = new URL(candidate); if (!['http:', 'https:'].includes(parsedNavigator.protocol) || parsedNavigator.username || parsedNavigator.password) throw new Error(); }
      catch { throw new Error('Navigator 服务地址无效'); }
    }
    return { ...ONLINE_DEFAULTS, host: '127.0.0.1', port: PRODUCTION_HTTP_PORT, navigator_url: navigatorUrl, navigator_entry_url: navigatorEntryUrl,
      test_mode: false, public_origin: origin };
  }
  if (env.PROSPECTOR_CENTER_MODE && env.PROSPECTOR_CENTER_MODE !== 'test') throw new Error('未知中心运行模式');
  const input = JSON.parse(readFileSync(ONLINE_CONFIG_PATH,"utf8")) as Record<string,unknown>;
  if(!input || typeof input!=="object" || Array.isArray(input)
    || Object.keys(input).some(key => !(key in ONLINE_DEFAULTS))
    || input.host !== ONLINE_DEFAULTS.host || input.port !== ONLINE_DEFAULTS.port || typeof input.test_mode!=="boolean"
    || typeof input.navigator_url !== 'string' || typeof input.navigator_entry_url !== 'string') throw new Error("本节点仅支持固定回环测试服务配置");
  for (const candidate of [input.navigator_url as string, input.navigator_entry_url as string]) {
   try { const parsedNavigator = new URL(candidate); if (!['http:', 'https:'].includes(parsedNavigator.protocol) || parsedNavigator.username || parsedNavigator.password) throw new Error(); }
   catch { throw new Error('Navigator 服务地址无效'); }
  }
  for(const [key,value] of Object.entries(ONLINE_DEFAULTS)) {
    if(typeof value === "number" && (!Number.isSafeInteger(input[key]) || (input[key] as number)<1)) throw new Error("在线配置阈值无效");
  }
  if((input.port as number)>PORT_MAX || (input.session_ttl_seconds as number)>SESSION_TTL_MAX_SECONDS
    || (input.password_concurrency as number)>ONLINE_DEFAULTS.password_concurrency
    || (input.request_body_bytes as number)>ONLINE_DEFAULTS.request_body_bytes) throw new Error("测试服务资源阈值超限");
  return input as OnlineConfig;
}
