// Synthetic center only. Verifies the real Electron IPC, preload and renderer path.
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes, generateKeyPairSync, sign, createPublicKey } = require('node:crypto');
const { buildSync } = require('esbuild');

const runtime = process.env.CODEX_NODE_PACKAGES;
if (!runtime) throw new Error('CODEX_NODE_PACKAGES must point to the existing bundled packages');
const { _electron } = require(path.join(runtime, 'playwright'));
const root = process.cwd();
const sandbox = mkdtempSync(path.join(tmpdir(), 'prospector-account-profile-'));
const out = path.join(root, '.work', 'account-profile');
const profileRoot = path.join(sandbox, 'profile');
mkdirSync(out, { recursive: true });
mkdirSync(profileRoot, { recursive: true });
const bundle = path.join(out, 'main.cjs');
buildSync({ entryPoints: ['tests/fixtures/offline-crm-desktop.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', packages: 'external' });

const userId = randomUUID();
const identity = { userId, displayName: 'Zayne', email: 'admin@yqn.com', emailVerified: true, identityAdmin: true, crmRoles: ['admin'], crmCapabilities: ['leads.create', 'leads.develop', 'leads.claim', 'leads.publish'] };
const sharedProfile = { userId, displayName: 'Zayne', avatarId: 'av-04', bio: '', growth: { totalXp: 6612, cycle: 7, level: 28, levelProgress: 16, levelCost: 21, todayXp: 18, todayKey: '2026-10-21' } };
const key = generateKeyPairSync('ed25519').privateKey;
const ok = data => ({ ok: true, data });
let center, base, app, page;
const pageErrors = [];

function offlineGrant() {
  const now = Date.now();
  const payload = JSON.stringify({ version: 1, audience: 'prospector-local', issuer: base, issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 72 * 60 * 60 * 1000).toISOString(), identity });
  return { payload, signature: sign(null, Buffer.from(payload), key).toString('base64url'), publicKey: createPublicKey(key).export({ format: 'pem', type: 'spki' }).toString() };
}

async function start() {
  center = http.createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const url = new URL(request.url, 'http://127.0.0.1');
    let answer;
    if (url.pathname.endsWith('/login') || url.pathname.endsWith('/refresh')) answer = ok({ token: randomBytes(32).toString('base64url'), refreshToken: randomBytes(32).toString('base64url'), identity, expiresAt: new Date(Date.now() + 3600000).toISOString(), offlineAccess: offlineGrant() });
    else if (url.pathname.endsWith('/me')) answer = ok(identity);
    else if (url.pathname === '/api/account/profile') answer = ok(sharedProfile);
    else if (url.pathname === '/api/crm/bootstrap') answer = ok({ userId, capabilities: identity.crmCapabilities, scope: 'summary', summary: { mine: 0, pool: 0 }, feedCursor: '0' });
    else if (url.pathname === '/api/crm/contact-changes') answer = ok({ items: [], nextCursor: '1', hasMore: false, headCursor: '1' });
    else if (url.pathname === '/api/crm/contacts') answer = ok({ items: [], total: 0 });
    else if (url.pathname === '/api/crm/notifications') answer = ok({ items: [], nextCursor: '0', hasMore: false });
    else answer = ok(undefined);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(answer));
  });
  await new Promise(resolve => center.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${center.address().port}`;
}

async function launch() {
  const env = { ...process.env, SMOKE_PROFILE: profileRoot, SMOKE_ROUTE: '/account', SMOKE_LOCAL_DB: '1', NODE_PATH: path.join(root, 'node_modules'), NODE_OPTIONS: '' };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'PROSPECTOR_DEV_PROFILE', 'PROSPECTOR_DEV_AUTOLOGIN']) delete env[name];
  app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [bundle], cwd: root, env });
  app.process().stderr.on('data', chunk => process.stderr.write(chunk));
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => pageErrors.push(error.message));
}

const invoke = (channel, ...args) => page.evaluate(({ channel, args }) => window.api.invoke(channel, ...args), { channel, args });
function unwrap(result) { assert.equal(result.ok, true, result.error?.message); return result.data; }

(async () => {
  await start();
  await launch();
  unwrap(await invoke('online:login', { baseUrl: base, email: identity.email, password: 'SyntheticFixture1', remember: false }));
  await page.getByText('跟进看板', { exact: true }).waitFor();
  await page.evaluate(() => { window.location.hash = '#/account'; });
  await page.getByText('基本信息', { exact: true }).waitFor();
  await page.getByText('Lv. 28', { exact: true }).waitFor();
  await page.getByText('16 / 21 XP', { exact: true }).waitFor();
  const avatar = await page.locator('.ant-avatar img').getAttribute('src');
  assert.match(avatar ?? '', /av-04/);
  assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
  await page.screenshot({ path: path.join(out, 'account-profile.png') });
  const report = { checks: ['center profile loaded through IPC', 'Zayne rendered', 'av-04 rendered', 'level 28 progress 16/21 rendered'], pageErrors, screenshot: path.join(out, 'account-profile.png') };
  writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(async error => {
  if (page) {
    console.error(JSON.stringify({ url: page.url(), body: (await page.locator('body').innerText().catch(() => '')).slice(0, 4000), pageErrors }, null, 2));
    await page.screenshot({ path: path.join(out, 'account-profile-failure.png') }).catch(() => {});
  }
  console.error(error.stack);
  process.exitCode = 1;
}).finally(async () => {
  if (app) await app.close().catch(() => {});
  if (center?.listening) await new Promise(resolve => center.close(resolve));
});
