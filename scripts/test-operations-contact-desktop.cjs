// Synthetic center and isolated Electron profile; no real account or customer writes.
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
const profile = mkdtempSync(path.join(tmpdir(), 'prospector-operations-contact-'));
const out = path.join(root, '.work', 'operations-contact-desktop');
mkdirSync(out, { recursive: true });
const bundle = path.join(out, 'main.cjs');
buildSync({ entryPoints: ['tests/fixtures/offline-crm-desktop.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', packages: 'external' });

const createdBy = randomUUID();
const userId = randomUUID();
const customerId = randomUUID();
const identity = { userId, displayName: 'Operations B', email: 'operations-b@example.invalid', emailVerified: true, identityAdmin: false, crmRoles: ['operations'], crmCapabilities: ['contacts.read', 'contacts.write'] };
const now = new Date().toISOString();
const permissions = { editableFields: ['firstName', 'lastName', 'title', 'phone', 'email'], canFollowup: true, canChangeStage: true, canSendMail: true, canShare: true };
const contact = { contactId: 1, customerId, customerVersion: 1, contactVersion: 1, companyId: 1, companyName: 'Shared Operations Fixture', email: 'shared@example.invalid', firstName: 'Alice', lastName: null, title: null, phone: null, linkedinUrl: null, country: 'BR', clientType: 'agent', language: 'en', stage: 'initial', status: 'pending', tags: [], extra: {}, touchStatus: 'untouched', assignee: '', source: 'fixture', sourceDetail: null, createdAt: now, updatedAt: now, ownerUserId: null, ownerName: null, origin: 'operations', state: 'pool', createdBy, assignmentStatus: null, canDelete: true, canEdit: true, canFollowup: true, canAssign: true, canSendMail: true, permissions };
const privateKey = generateKeyPairSync('ed25519').privateKey;
const ok = data => ({ ok: true, data });
const fail = (code, message) => ({ ok: false, error: { code, message } });
let center, base, app, page, updateCount = 0, detailCount = 0;
const pageErrors = [];
function detail() { return { contact: structuredClone(contact), company: { companyId: 1, name: contact.companyName, domain: null, backcheckData: null, canEdit: true, revision: 'fixture-revision' }, activities: [], canEdit: true, canFollowup: true, canAssign: true, canDelete: true, mailAvailable: false, permissions }; }
function grant() {
  const timestamp = Date.now();
  const payload = JSON.stringify({ version: 1, audience: 'prospector-local', issuer: base, issuedAt: new Date(timestamp).toISOString(), expiresAt: new Date(timestamp + 72 * 60 * 60 * 1000).toISOString(), identity });
  return { payload, signature: sign(null, Buffer.from(payload), privateKey).toString('base64url'), publicKey: createPublicKey(privateKey).export({ format: 'pem', type: 'spki' }).toString() };
}
async function startCenter() {
  center = http.createServer(async (request, response) => {
    let raw = '';
    for await (const part of request) raw += part;
    const body = raw ? JSON.parse(raw) : undefined;
    const url = new URL(request.url, base ?? 'http://127.0.0.1');
    let result;
    if (url.pathname.endsWith('/login') || url.pathname.endsWith('/refresh')) result = ok({ token: randomBytes(32).toString('base64url'), refreshToken: randomBytes(32).toString('base64url'), identity, expiresAt: new Date(Date.now() + 3600000).toISOString(), offlineAccess: grant() });
    else if (url.pathname.endsWith('/me')) result = ok(identity);
    else if (url.pathname === '/api/crm/bootstrap') result = ok({ userId, capabilities: identity.crmCapabilities, scope: 'shared', summary: { mine: 0, pool: 1 }, feedCursor: '0' });
    else if (request.method === 'GET' && url.pathname === '/api/crm/contacts') result = ok({ items: [contact], total: 1 });
    else if (request.method === 'GET' && url.pathname === '/api/crm/contacts/1') { assert.equal(url.searchParams.get('customerId'), customerId); detailCount++; result = ok(detail()); }
    else if (request.method === 'POST' && url.pathname === '/api/crm/contacts/1/update') {
      assert.equal(body.customerId, customerId);
      assert.equal(body.expectedVersion, 1);
      assert.deepEqual(body.fields, { title: 'Operations B Edited' });
      assert.equal(typeof body.idempotencyKey, 'string');
      contact.title = body.fields.title;
      contact.contactVersion++;
      updateCount++;
      result = ok(detail());
    } else if (url.pathname === '/api/crm/notifications') result = ok({ items: [], nextCursor: '0', hasMore: false });
    else if (url.pathname.endsWith('/logout')) result = ok(undefined);
    else result = fail('NOT_FOUND', `Fixture endpoint absent: ${url.pathname}`);
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
    const env = { ...process.env, SMOKE_PROFILE: profile, SMOKE_CONTACT_DATAFLOW: '1', NODE_PATH: path.join(root, 'node_modules'), NODE_OPTIONS: '' };
    for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'PROSPECTOR_DEV_PROFILE', 'PROSPECTOR_DEV_AUTOLOGIN']) delete env[name];
    app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [bundle], cwd: root, env });
    page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => pageErrors.push(error.message));
    unwrap(await invoke('online:login', { baseUrl: base, email: identity.email, password: 'SyntheticFixture1', remember: true }));
    const row = page.locator('.ant-table-tbody tr').filter({ hasText: 'Alice' });
    await row.waitFor();
    await row.dblclick();
    await page.locator('.contact-detail-tabs').waitFor();
    assert.ok(detailCount >= 1, 'detail HTTP request did not run');
    const titleRow = page.locator('.contact-detail-tabs').getByText('职位', { exact: true }).locator('..');
    const editButton = titleRow.locator('button');
    assert.equal(await editButton.isEnabled(), true, JSON.stringify({ message: 'operations user cannot edit the other operations contact', status: unwrap(await invoke('online:status')), titleRow: await titleRow.evaluate(node => node.outerHTML) }));
    await editButton.click();
    const input = titleRow.locator('input');
    await input.fill('Operations B Edited');
    await input.press('Enter');
    await page.waitForFunction(() => document.querySelector('.contact-detail-tabs')?.textContent?.includes('Operations B Edited'));
    assert.equal(updateCount, 1);
    assert.deepEqual(pageErrors, []);
    console.log(JSON.stringify({ ok: true, checks: ['operations B opens operations A contact in real Electron renderer', 'editable title saves through preload, IPC and authenticated HTTP'], detailCount, updateCount, pageErrors }, null, 2));
  } catch (error) {
    if (page) console.error(JSON.stringify({ url: page.url(), body: (await page.locator('body').innerText().catch(() => '')).slice(0, 2000), pageErrors, detailCount, updateCount }));
    throw error;
  } finally {
    if (app) await app.close();
    if (center) await new Promise(resolve => center.close(resolve));
    assert.equal(path.dirname(path.resolve(profile)).toLowerCase(), path.resolve(tmpdir()).toLowerCase());
    assert.ok(path.basename(profile).startsWith('prospector-operations-contact-'));
    rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
