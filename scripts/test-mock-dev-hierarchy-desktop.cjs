// Isolated real-Electron smoke for the development mock hierarchy; no writes outside test userData.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const runtime = process.env.CODEX_NODE_PACKAGES;
if (!runtime) throw new Error('CODEX_NODE_PACKAGES must point to bundled packages');
const { _electron } = require(path.join(runtime, 'playwright'));
const root = process.cwd();
const password = process.env.PROSPECTOR_MOCK_PASSWORD || '';
if (!password) throw new Error('PROSPECTOR_MOCK_PASSWORD is required');
const manifest = JSON.parse(fs.readFileSync(path.join(root, '.work/mock-dev-hierarchy/manifest.json'), 'utf8'));
const member = manifest.accounts.find(account => account.email === 'mock.hierarchy.member.anna@yqn.com');
if (!member) throw new Error('Mock member Anna is missing');
const sourceProfiles = path.join(process.env.APPDATA || '', 'prospecting-email-dev', 'accounts');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'prospector-mock-hierarchy-'));
const targetAccounts = path.join(profile, 'accounts');
fs.mkdirSync(targetAccounts, { recursive: true });
for (const account of manifest.accounts) {
  const key = createHash('sha256').update(JSON.stringify([manifest.baseUrl, account.userId])).digest('hex');
  const source = path.join(sourceProfiles, key);
  if (!fs.existsSync(source)) throw new Error(`Mock local profile is missing: ${account.email}`);
  fs.cpSync(source, path.join(targetAccounts, key), { recursive: true });
}

let app;
(async () => {
  const errors = [];
  try {
    const env = { ...process.env, PROSPECTOR_DEV_PROFILE: profile, NODE_PATH: path.join(root, 'node_modules'), NODE_OPTIONS: '' };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'PROSPECTOR_DEV_AUTOLOGIN']) delete env[key];
    app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [root], cwd: root, env });
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push(error.message));
    const login = await page.evaluate(({ baseUrl, email, password }) => window.api.invoke('online:login', { baseUrl, email, password, remember: true }), {
      baseUrl: manifest.baseUrl, email: member.email, password,
    });
    assert.equal(login.ok, true, login.error?.message);
    const team = await page.evaluate(() => window.api.invoke('online:team-context'));
    assert.equal(team.ok, true, team.error?.message);
    assert.equal(team.data.team.name, 'Mock 华东销售组');
    const contacts = await page.evaluate(() => window.api.invoke('online:contact-list', { search: '', limit: 50, offset: 0, scope: 'all' }));
    assert.equal(contacts.ok, true, contacts.error?.message);
    assert.ok(contacts.data.items.some(contact => contact.email === 'jonas.berg@nordic-freight.mock'));
    assert.ok(contacts.data.items.some(contact => contact.email === 'rafael.souza@coral-import.mock'));
    let tasks;
    for (let attempt = 0; attempt < 20; attempt++) {
      tasks = await page.evaluate(() => window.api.invoke('online:task-list', { limit: 50, offset: 0 }));
      if (tasks.ok) break;
      await page.waitForTimeout(250);
    }
    assert.equal(tasks.ok, true, tasks.error?.message);
    assert.ok(tasks.data.items.length >= 1);
    const inbox = await page.evaluate(() => window.api.invoke('inbox:list'));
    assert.equal(inbox.success, true, inbox.error);
    assert.ok(inbox.data.some(message => String(message.subject).includes('Mock')));
    assert.deepEqual(errors, []);
    process.stdout.write(JSON.stringify({ ok: true, email: member.email, team: team.data.team.name, contacts: contacts.data.total, tasks: tasks.data.total, inbox: inbox.data.length }, null, 2) + '\n');
  } finally {
    if (app) await app.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
