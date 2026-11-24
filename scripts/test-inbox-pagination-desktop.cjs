// Isolated Electron smoke for the Foxmail-style continuous inbox list.
const assert = require('node:assert/strict');
const { randomBytes, randomUUID, generateKeyPairSync, sign, createPublicKey } = require('node:crypto');
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const http = require('node:http');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { buildSync } = require('esbuild');

const runtime = process.env.CODEX_NODE_PACKAGES;
if (!runtime) throw new Error('CODEX_NODE_PACKAGES must point to the bundled packages');
const { _electron } = require(path.join(runtime, 'playwright'));
const root = process.cwd();
const profile = mkdtempSync(path.join(tmpdir(), 'prospector-inbox-pagination-'));
const out = path.join(root, '.work', 'inbox-pagination-desktop');
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
function unwrap(result) {
  assert.equal(result.ok, true, result.error?.message);
  return result.data;
}
function localData(result) {
  assert.equal(result.success, true, result.error);
  return result.data;
}

async function scrollInboxToBottom() {
  return page.evaluate(() => {
    const pane = document.querySelector('.inbox-list-pane');
    if (!pane) throw new Error('inbox list pane missing');
    const candidates = [...pane.querySelectorAll('*')].filter(node => node instanceof HTMLElement && node.scrollHeight > node.clientHeight + 20);
    const scroller = candidates.sort((left, right) => right.scrollHeight - left.scrollHeight)[0];
    if (!scroller) throw new Error('inbox scroller missing');
    scroller.scrollTop = scroller.scrollHeight;
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    return { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight };
  });
}

(async () => {
  try {
    await startCenter();
    const env = { ...process.env, SMOKE_PROFILE: profile, SMOKE_ROUTE: '/inbox', SMOKE_LOCAL_DB: '1', SMOKE_INBOX_BULK: '1', NODE_PATH: path.join(root, 'node_modules'), NODE_OPTIONS: '' };
    for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'PROSPECTOR_DEV_PROFILE', 'PROSPECTOR_DEV_AUTOLOGIN']) delete env[name];
    app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [bundle], cwd: root, env });
    app.process().stderr?.on('data', chunk => process.stderr.write(chunk));
    page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false); win.show(); win.focus(); });
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('crash', () => pageErrors.push('renderer crashed'));

    unwrap(await invoke('online:login', { baseUrl: base, email: identity.email, password: 'SyntheticFixture1', remember: true }));
    await page.getByText('Bulk mail 001', { exact: true }).waitFor();
    assert.equal(await page.locator('.ant-pagination').count(), 0);
    assert.equal(await page.getByText('Bulk mail 300', { exact: true }).count(), 0);

    const first = localData(await invoke('inbox:list', { limit: 200 }));
    assert.equal(first.items.length, 200);
    assert.equal(first.total, 451);
    assert.ok(first.nextCursor);
    assert.equal(first.items.some(item => item.subject === 'Bulk mail 220'), false);

    const second = localData(await invoke('inbox:list', { limit: 200, cursor: first.nextCursor }));
    assert.equal(second.items.length, 200);
    assert.equal(second.items.some(item => item.subject === 'Bulk mail 220'), true);
    assert.ok(second.nextCursor);

    let scroll = null;
    let visibleOlder = false;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      scroll = await scrollInboxToBottom();
      if (await page.getByText(/Bulk mail 3\d\d/).count()) { visibleOlder = true; break; }
      await page.waitForTimeout(900);
    }
    assert.equal(visibleOlder, true, `older mail was not rendered after scrolling: ${JSON.stringify(scroll)}`);
    assert.deepEqual(pageErrors, []);

    const report = { ok: true, firstPage: { items: first.items.length, total: first.total, nextCursor: true }, secondPage: { items: second.items.length, nextCursor: true }, visibleAfterScroll: 'Bulk mail 300-399', paginationControls: 0, scroll, pageErrors };
    writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    if (page) {
      const showError = page.getByText('Show Error', { exact: true });
      if (await showError.count()) await showError.click().catch(() => {});
      await page.waitForTimeout(200);
      console.error('PAGE', JSON.stringify({ url: page.url(), body: (await page.locator('body').innerText().catch(() => '')).slice(0, 5000), pageErrors }));
    }
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    if (app) await app.close().catch(() => {});
    if (center?.listening) await new Promise(resolve => center.close(resolve));
    assert.equal(path.dirname(path.resolve(profile)).toLowerCase(), path.resolve(tmpdir()).toLowerCase());
    assert.ok(path.basename(profile).startsWith('prospector-inbox-pagination-'));
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
})();
