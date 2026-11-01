// Isolated Electron smoke for the first-sync progress window; no real mailbox or center is touched.
const assert = require('node:assert/strict');
const { randomBytes, randomUUID, generateKeyPairSync, sign, createPublicKey } = require('node:crypto');
const { mkdtempSync, mkdirSync, rmSync } = require('node:fs');
const http = require('node:http');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { buildSync } = require('esbuild');

const runtime = process.env.CODEX_NODE_PACKAGES;
if (!runtime) throw new Error('CODEX_NODE_PACKAGES must point to the bundled packages');
const { _electron } = require(path.join(runtime, 'playwright'));
const root = process.cwd();
const profile = mkdtempSync(path.join(tmpdir(), 'prospector-inbox-progress-'));
const out = path.join(root, '.work', 'inbox-sync-progress-desktop');
mkdirSync(out, { recursive: true });
const bundle = path.join(out, 'main.cjs');
buildSync({ entryPoints: ['tests/fixtures/offline-crm-desktop.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', packages: 'external' });

const userId = randomUUID();
const identity = { userId, displayName: 'Inbox Fixture', email: 'inbox-fixture@example.invalid', emailVerified: true, identityAdmin: false, crmRoles: ['sales'], crmCapabilities: ['contacts.read'] };
const privateKey = generateKeyPairSync('ed25519').privateKey;
const ok = data => ({ ok: true, data });
let center, base, app, page;
const pageErrors = [];
function grant() {
  const timestamp = Date.now();
  const payload = JSON.stringify({ version: 1, audience: 'prospector-local', issuer: base, issuedAt: new Date(timestamp).toISOString(), expiresAt: new Date(timestamp + 72 * 60 * 60 * 1000).toISOString(), identity });
  return { payload, signature: sign(null, Buffer.from(payload), privateKey).toString('base64url'), publicKey: createPublicKey(privateKey).export({ format: 'pem', type: 'spki' }).toString() };
}
async function startCenter() {
  center = http.createServer((request, response) => {
    const url = new URL(request.url, base ?? 'http://127.0.0.1');
    let result;
    if (url.pathname.endsWith('/login') || url.pathname.endsWith('/refresh')) result = ok({ token: randomBytes(32).toString('base64url'), refreshToken: randomBytes(32).toString('base64url'), identity, expiresAt: new Date(Date.now() + 3600000).toISOString(), offlineAccess: grant() });
    else if (url.pathname.endsWith('/me')) result = ok(identity);
    else if (url.pathname === '/api/crm/bootstrap') result = ok({ userId, capabilities: identity.crmCapabilities, scope: 'personal', summary: { mine: 0, pool: 0 }, feedCursor: '0' });
    else if (url.pathname === '/api/crm/notifications') result = ok({ items: [], nextCursor: '0', hasMore: false });
    else if (url.pathname.endsWith('/logout')) result = ok(undefined);
    else result = { ok: false, error: { code: 'NOT_FOUND', message: `Fixture endpoint absent: ${url.pathname}` } };
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(result));
  });
  await new Promise(resolve => center.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${center.address().port}`;
}
const invoke = (channel, input) => page.evaluate(({ channel, input }) => window.api.invoke(channel, input), { channel, input });
function unwrap(result) { assert.equal(result.ok, true, result.error?.message); return result.data; }
(async () => {
  try {
    await startCenter();
    const env = { ...process.env, SMOKE_PROFILE: profile, SMOKE_ROUTE: '/inbox', SMOKE_LOCAL_DB: '1', SMOKE_INBOX_PROGRESS: '1', NODE_PATH: path.join(root, 'node_modules'), NODE_OPTIONS: '' };
    for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'PROSPECTOR_DEV_PROFILE', 'PROSPECTOR_DEV_AUTOLOGIN']) delete env[name];
    app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [bundle], cwd: root, env });
    page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => pageErrors.push(error.message));
    unwrap(await invoke('online:login', { baseUrl: base, email: identity.email, password: 'SyntheticFixture1', remember: true }));
    const inboxNav = page.getByText('收件箱', { exact: true });
    await inboxNav.click({ force: true });
    const refresh = page.getByRole('button', { name: '刷新' });
    await refresh.waitFor();
    const typography = await page.evaluate(() => {
      const body = getComputedStyle(document.body);
      return { family: body.fontFamily, size: body.fontSize, rendering: body.getPropertyValue('font-synthesis') };
    });
    assert.match(typography.family, /Noto Sans SC/);
    assert.equal(typography.size, '14px');
    assert.equal(typography.rendering, 'none');
    await page.evaluate(() => document.querySelector('.identity-route-loading')?.remove());
    const mainScreenshot = path.join(out, 'main-typography.png');
    await page.screenshot({ path: mainScreenshot });
    await refresh.evaluate(button => button.click());
    await page.getByText('已拉取 125 / 共需拉取 500').waitFor();
    await page.getByText('Fixture pricing reply').waitFor();
    await page.waitForTimeout(300);
    const modal = page.locator('.ant-modal-content');
    await modal.waitFor();
    const screenshot = path.join(out, 'inbox-sync-progress.png');
    await page.evaluate(() => document.querySelector('.identity-route-loading')?.remove());
    await modal.screenshot({ path: screenshot });
    await page.getByRole('button', { name: '转入后台' }).click();
    await page.getByRole('button', { name: '后台拉取中' }).waitFor();
    assert.deepEqual(pageErrors, []);
    console.log(JSON.stringify({ ok: true, checks: ['real Electron inbox route renders', 'resolved font is Noto Sans SC at 14px without synthesized weights', 'progress shows cumulative pulled/required', 'current subject and mailbox are visible', 'dialog moves to background without cancelling'], typography, mainScreenshot, screenshot, pageErrors }, null, 2));
  } catch (error) {
    if (page) console.error(JSON.stringify({ url: page.url(), body: (await page.locator('body').innerText().catch(() => '')).slice(0, 3000), controls: await page.locator('a,button').evaluateAll(nodes => nodes.slice(0, 40).map(node => ({ tag: node.tagName, text: node.textContent?.trim(), href: node.getAttribute('href') }))).catch(() => []), pageErrors }, null, 2));
    throw error;
  } finally {
    if (app) await app.close();
    if (center) await new Promise(resolve => center.close(resolve));
    assert.equal(path.dirname(path.resolve(profile)).toLowerCase(), path.resolve(tmpdir()).toLowerCase());
    assert.ok(path.basename(profile).startsWith('prospector-inbox-progress-'));
    rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
