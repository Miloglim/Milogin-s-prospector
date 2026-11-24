import { app, safeStorage } from 'electron';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { Log } from '../logger';
import { currentCenterAccessToken } from '../services/center-identity.service';
import { navigatorBaseUrl } from './navigator-auth.adapter';

const REQUEST_TIMEOUT_MS = 20_000;
const PARTNER_SECRET_PREFIX = 'nav_sec_';
const file = () => path.join(app.getPath('userData'), 'navigator-partner.enc');
let epoch = 0;

async function loadKey(base: string): Promise<string | null> {
  try {
    if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') return null;
    const value = JSON.parse(safeStorage.decryptString(await fs.readFile(file()))) as { base?: unknown; key?: unknown };
    return value.base === base && typeof value.key === 'string' && value.key.startsWith(PARTNER_SECRET_PREFIX) ? value.key : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') Log.warn('navigator.partner', '无法读取接口凭证，请重新获取');
    return null;
  }
}

async function saveKey(base: string, key: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
    throw new Error('系统安全存储不可用，无法保存 Navigator 接口凭证');
  }
  const target = file();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  await fs.writeFile(temporary, safeStorage.encryptString(JSON.stringify({ base, key })), { mode: 0o600 });
  await fs.rename(temporary, target);
  epoch++;
}

export async function clearNavigatorPartnerKey(): Promise<void> {
  try { await fs.rm(file(), { force: true }); } finally { epoch++; }
}

export function navigatorPartnerEpoch(): number { return epoch; }

export async function navigatorPartnerStatus(): Promise<{ configured: boolean; baseUrl: string | null }> {
  try {
    const base = navigatorBaseUrl();
    return { configured: !!(await loadKey(base)), baseUrl: base };
  } catch {
    return { configured: false, baseUrl: null };
  }
}

export async function saveNavigatorPartnerKey(key: string): Promise<string> {
  const trimmed = key.trim();
  if (!trimmed.startsWith(PARTNER_SECRET_PREFIX)) throw new Error('请填写 Navigator 接口凭证（nav_sec_ 开头）');
  const base = navigatorBaseUrl();
  const response = await fetch(`${base}/api/partner/v1/rates?limit=1`, {
    headers: { Authorization: `Bearer ${trimmed}` }, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 403) throw new Error('Navigator 接口凭证无效或已撤销');
  if (!response.ok) throw new Error('Navigator 接口凭证验证失败');
  await saveKey(base, trimmed);
  return base;
}

export async function ensureNavigatorPartnerKey(): Promise<string> {
  const base = navigatorBaseUrl();
  const existing = await loadKey(base);
  if (existing) return existing;
  const centerToken = currentCenterAccessToken();
  if (!centerToken) throw new Error('请先登录中心账号，再获取 Navigator 接口凭证');
  const response = await fetch(`${base}/api/prospector/partner-key`, {
    method: 'POST', headers: { Authorization: `Bearer ${centerToken}` },
    redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => null) as { ok?: boolean; data?: { secret?: unknown }; error?: string } | null;
  if (!response.ok || !payload?.ok) throw new Error(payload?.error || 'Navigator 接口凭证获取失败，请在账号页手动创建');
  const secret = typeof payload.data?.secret === 'string' ? payload.data.secret : '';
  if (!secret.startsWith(PARTNER_SECRET_PREFIX)) throw new Error('Navigator 返回的接口凭证无效');
  await saveKey(base, secret);
  Log.info('navigator.partner', '已自动获取 Prospector 专用接口凭证');
  return secret;
}

function partnerQuery(filters: Record<string, unknown>) {
  const params = new URLSearchParams();
  const value = (key: string) => filters[key] == null ? '' : String(filters[key]);
  if (value('pol')) params.set('origin', value('pol'));
  if (value('pod')) params.set('destination', value('pod'));
  if (value('container')) params.set('container_type', value('container'));
  params.set('limit', value('limit') || '20');
  if (value('offset')) params.set('cursor', value('offset'));
  params.set('sort', 'price');
  params.set('direction', 'asc');
  return params;
}

export async function queryNavigatorPartnerRows(filters: Record<string, unknown>, queryId: string): Promise<{ ok: boolean; data?: { rows: Record<string, unknown>[]; total: number }; error?: string }> {
  const base = navigatorBaseUrl();
  let key = await ensureNavigatorPartnerKey();
  const request = async () => fetch(`${base}/api/partner/v1/rates?${partnerQuery(filters)}`, {
    headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let response = await request();
  if (response.status === 401 || response.status === 403) {
    await clearNavigatorPartnerKey();
    key = await ensureNavigatorPartnerKey();
    response = await request();
  }
  const payload = await response.json().catch(() => null) as { ok?: boolean; data?: { items?: unknown[]; total?: unknown }; error?: string } | null;
  if (!response.ok || !payload?.ok || !Array.isArray(payload.data?.items)) return { ok: false, error: payload?.error || 'Navigator 接口查询失败' };
  const rows = payload.data.items.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)).map(item => ({
    content_key: item.rate_id, pol: item.origin, pod: item.destination, pod_raw: item.destination,
    carrier: item.carrier, container_type: item.container_type, price_usd: item.price,
    currency: item.currency, valid_from: item.valid_from, valid_to: item.valid_to, etd: item.etd,
    route: item.trade_lane, free_days: item.free_days, remark: item.remark,
    source_group: item.source_group, sender: item.sender, message_time: item.message_time,
    validity_raw: item.validity_raw, dead_freight: item.dead_freight,
    dead_freight_currency: item.dead_freight_currency,
    status: item.lifecycle_status === 'active' ? '当前生效' : item.lifecycle_status,
  }));
  Log.debug('navigator.partner', `接口查价 query=${queryId} rows=${rows.length}`);
  return { ok: true, data: { rows, total: Number(payload.data.total) || rows.length } };
}
