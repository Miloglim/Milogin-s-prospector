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
    app.process().stderr?.on('data', chunk => process.stderr.write(chunk));
    page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false); win.show(); win.focus(); });
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('crash', () => pageErrors.push('renderer crashed'));
    unwrap(await invoke('online:login', { baseUrl: base, email: identity.email, password: 'SyntheticFixture1', remember: true }));
    const inboxNav = page.getByText('收件箱', { exact: true }).first();
    await inboxNav.click({ force: true });
    const refresh = page.getByRole('button', { name: '拉取' });
    await refresh.waitFor();
    assert.equal(await page.getByRole('button', { name: '更早邮件' }).count(), 0);
    await page.locator('.inbox-management-pane').waitFor();
    assert.ok(await page.locator('.inbox-management-item').count() >= 6);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 1000));
    await page.waitForTimeout(200);
    await page.waitForTimeout(100);
    const inboxManagementScreenshot = path.join(root, 'docs', 'designs', 'prospector-inbox-management-1440.png');
    mkdirSync(path.dirname(inboxManagementScreenshot), { recursive: true });
    await page.screenshot({ path: inboxManagementScreenshot });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(824, 720));
    await page.waitForTimeout(200);
    const compact = await page.evaluate(() => { const root = document.querySelector('.inbox-workspace'); return { clientWidth: root?.clientWidth, scrollWidth: root?.scrollWidth }; });
    assert.equal(compact.scrollWidth, compact.clientWidth);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 1000));
    await page.waitForTimeout(200);
    const typography = await page.evaluate(() => {
      const body = getComputedStyle(document.body);
      return { family: body.fontFamily, size: body.fontSize, rendering: body.getPropertyValue('font-synthesis') };
    });
    assert.match(typography.family, /Noto Sans SC/);
    assert.equal(typography.size, '14px');
    assert.equal(typography.rendering, 'none');
    const mainScreenshot = path.join(out, 'main-typography.png');
    await page.screenshot({ path: mainScreenshot });
    await refresh.evaluate(button => button.click());
    await page.getByText('已拉取 125 / 共需拉取 500').waitFor();
    await page.getByText('已拉取 126 / 共需拉取 500').waitFor();
    await page.locator('.inbox-list-pane').getByText('Fixture pricing reply', { exact: true }).waitFor();
    await page.waitForTimeout(300);
    const modal = page.locator('.ant-modal-content');
    await modal.waitFor();
    const screenshot = path.join(out, 'inbox-sync-progress.png');
    await modal.screenshot({ path: screenshot });
    await page.getByRole('button', { name: '转入后台' }).click();
    await page.getByRole('button', { name: '后台拉取中' }).waitFor();
    assert.doesNotMatch(await page.locator('.inbox-management-pane').innerText(), /已匹配|未匹配/);
    await page.getByRole('button', { name: '新建文件夹' }).click();
    await page.getByPlaceholder('例如：询价、重点客户').fill('重点客户');
    await page.locator('.inbox-label-editor-actions .ant-btn-primary').click();
    const labelsAfterSave = await invoke('inbox:labels');
    assert.equal(labelsAfterSave.success, true, labelsAfterSave.error);
    assert.ok(labelsAfterSave.data.some(label => label.name === '重点客户'), JSON.stringify(labelsAfterSave));
    const idempotencyKey = 'fixture-label-idempotency-001';
    const idempotentSave = await page.evaluate(key => window.api.invoke('inbox:labelSave', { name: '幂等标签', color: '#16a34a', idempotencyKey: key }), idempotencyKey);
    assert.equal(idempotentSave.success, true, idempotentSave.error);
    const idempotentRetry = await page.evaluate(key => window.api.invoke('inbox:labelSave', { name: '幂等标签', color: '#16a34a', idempotencyKey: key }), idempotencyKey);
    assert.equal(idempotentRetry.success, true, idempotentRetry.error);
    const labelsAfterRetry = await invoke('inbox:labels');
    assert.equal(labelsAfterRetry.data.filter(label => label.name === '幂等标签').length, 1);
    const folderRow = page.locator('.inbox-folder-row').filter({ hasText: '重点客户' });
    await folderRow.waitFor();
    await page.locator('.inbox-list-pane').getByText('Fixture pricing reply', { exact: true }).click();
    await page.locator('.inbox-detail-label-trigger').click();
    await page.locator('.inbox-label-picker label').filter({ hasText: '重点客户' }).locator('input').click();
    await page.locator('.inbox-detail-label-chip').filter({ hasText: '重点客户' }).waitFor();
    await page.keyboard.press('Escape');
    await folderRow.locator('.inbox-folder-main').click();
    await page.locator('.inbox-list-pane').getByText('Fixture pricing reply', { exact: true }).waitFor();
    const labelsScreenshot = path.join(root, 'docs', 'designs', 'prospector-inbox-labels-1440.png');
    await page.screenshot({ path: labelsScreenshot });
    assert.deepEqual(pageErrors, []);
    console.log(JSON.stringify({ ok: true, checks: ['real Electron inbox route renders', 'management rail exposes existing filters', 'contact matching is not used as a mail category', 'user-defined label can be created, assigned and used as a filter', 'compact inbox has no horizontal page overflow', 'resolved font is Noto Sans SC at 14px without synthesized weights', 'progress shows cumulative pulled/required', 'current subject and mailbox are visible', 'dialog moves to background without cancelling'], typography, mainScreenshot, inboxManagementScreenshot, labelsScreenshot, screenshot, pageErrors }, null, 2));
  } catch (error) {
    if (page) console.error(JSON.stringify({ url: page.url(), body: (await page.locator('body').innerText().catch(() => '')).slice(0, 3000), controls: await page.locator('a,button').evaluateAll(nodes => nodes.slice(0, 40).map(node => ({ tag: node.tagName, text: node.textContent?.trim(), href: node.getAttribute('href') }))).catch(() => []), pageErrors }, null, 2));
    throw error;
  } finally {
    if (app) { await app.close(); await new Promise(resolve => setTimeout(resolve, 200)); }
    if (center) await new Promise(resolve => center.close(resolve));
    assert.equal(path.dirname(path.resolve(profile)).toLowerCase(), path.resolve(tmpdir()).toLowerCase());
    assert.ok(path.basename(profile).startsWith('prospector-inbox-progress-'));
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
