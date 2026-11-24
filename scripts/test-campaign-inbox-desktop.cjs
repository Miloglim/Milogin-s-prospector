// Isolated Electron smoke for campaign task links into the existing inbox.
const assert = require('node:assert/strict');
const { randomBytes, randomUUID, generateKeyPairSync, sign, createPublicKey } = require('node:crypto');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const http = require('node:http');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { buildSync } = require('esbuild');

const runtime = process.env.CODEX_NODE_PACKAGES;
if (!runtime) throw new Error('CODEX_NODE_PACKAGES must point to the bundled packages');
const { _electron } = require(path.join(runtime, 'playwright'));
const root = process.cwd();
const profile = mkdtempSync(path.join(tmpdir(), 'prospector-campaign-inbox-'));
const out = path.join(root, '.work', 'campaign-inbox-desktop');
const designs = path.join(root, 'docs', 'designs');
mkdirSync(out, { recursive: true });
mkdirSync(designs, { recursive: true });
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

async function workspaceWidth(page) {
  return page.evaluate(() => {
    const workspace = document.querySelector('.inbox-workspace');
    return { clientWidth: workspace?.clientWidth, scrollWidth: workspace?.scrollWidth };
  });
}

(async () => {
  try {
    await startCenter();
    const env = { ...process.env, SMOKE_PROFILE: profile, SMOKE_ROUTE: '/campaigns', SMOKE_LOCAL_DB: '1', SMOKE_CAMPAIGN_INBOX: '1', NODE_PATH: path.join(root, 'node_modules'), NODE_OPTIONS: '' };
    for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'PROSPECTOR_DEV_PROFILE', 'PROSPECTOR_DEV_AUTOLOGIN']) delete env[name];
    app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [bundle], cwd: root, env });
    app.process().stderr?.on('data', chunk => process.stderr.write(chunk));
    page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false); win.show(); win.focus(); });
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('crash', () => pageErrors.push('renderer crashed'));

    unwrap(await invoke('online:login', { baseUrl: base, email: identity.email, password: 'SyntheticFixture1', remember: true }));
    const sendCenterNav = page.getByText('发送中心', { exact: true }).first();
    await sendCenterNav.click({ force: true });
    await page.getByRole('button', { name: '查看任务已收到邮件 2 封' }).click();
    const filter = page.locator('.inbox-campaign-filter');
    await filter.waitFor();
    assert.match(await filter.innerText(), /Brazil outreach/);
    assert.match(await filter.innerText(), /已收到/);

    const list = page.locator('.inbox-list-pane');
    await list.getByText('Campaign reply', { exact: true }).waitFor();
    assert.doesNotMatch(await list.innerText(), /Campaign bounce|Other reply/);

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 1000));
    await page.waitForTimeout(200);
    const wide = await workspaceWidth(page);
    assert.equal(wide.scrollWidth, wide.clientWidth);
    await page.screenshot({ path: path.join(designs, 'prospector-inbox-campaign-filter-1440.png') });

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(824, 720));
    await page.waitForTimeout(200);
    const compact = await workspaceWidth(page);
    assert.equal(compact.scrollWidth, compact.clientWidth);

    await page.getByRole('button', { name: '清除任务邮件筛选' }).click();
    await filter.waitFor({ state: 'detached' });
    await list.getByText('Campaign bounce', { exact: true }).waitFor();
    await list.getByText('Other reply', { exact: true }).waitFor();
    assert.match(await list.innerText(), /Campaign reply/);
    assert.deepEqual(pageErrors, []);

    const result = { ok: true, filteredSubject: 'Campaign reply', restoredSubjects: ['Campaign reply', 'Campaign bounce', 'Other reply'], widths: { wide, compact }, pageErrors };
    writeFileSync(path.join(out, 'report.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    if (page) console.error('PAGE', JSON.stringify({ url: page.url(), body: (await page.locator('body').innerText().catch(() => '')).slice(0, 3000), pageErrors }));
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    if (app) await app.close().catch(() => {});
    if (center?.listening) await new Promise(resolve => center.close(resolve));
  }
})();
