// Synthetic center and isolated Electron profiles; no real account or customer writes.
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
const out = path.join(root, '.work', 'team-workspace-desktop');
const designs = process.env.PROSPECTOR_SMOKE_OUTPUT_DIR || path.join(root, 'docs', 'designs');
mkdirSync(out, { recursive: true });
mkdirSync(designs, { recursive: true });
const bundle = path.join(out, 'main.cjs');
buildSync({ entryPoints: ['tests/fixtures/offline-crm-desktop.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', packages: 'external' });

const customerId = randomUUID();
const now = new Date().toISOString();
const operationsUserId = randomUUID();
const salesUserId = randomUUID();
const contact = {
  contactId: 1, customerId, customerVersion: 1, contactVersion: 1, companyId: 1, companyName: 'Atlantic Trade',
  email: 'ana@example.invalid', firstName: 'Ana', lastName: 'Lima', title: 'Buyer', phone: null, whatsapp: null,
  linkedinUrl: null, country: 'Brazil', clientType: 'agent', language: 'en', stage: 'f2', status: '', tags: [], extra: {},
  touchStatus: 'replied', relationshipStage: 'quoting', assignee: '', source: 'fixture', sourceDetail: null,
  sourceLevel1: null, sourceLevel2: null, createdAt: now, updatedAt: now, ownerUserId: salesUserId, ownerName: 'Sales One',
  origin: 'personal', state: 'owned', lastFollowupAt: now,
};
const task = { taskId: randomUUID(), customerId, title: 'Reply with revised ocean quote', dueAt: new Date(Date.now() + 86400000).toISOString(), status: 'open', version: 1, responsibleUserId: salesUserId, responsibleName: 'Sales One', createdBy: salesUserId, createdAt: now, updatedAt: now, completedAt: null, completedBy: null, feedback: null, canManage: true };
const privateKey = generateKeyPairSync('ed25519').privateKey;
const ok = data => ({ ok: true, data });
const fail = (code, message) => ({ ok: false, error: { code, message } });
let center, base, currentIdentity, currentTeamContext;
const counters = { contacts: 0, details: 0, tasks: 0, teamContexts: 0, teamDetails: 0, teamMonitoring: 0, candidates: 0 };

function teamContext(role) {
  const leader = { userId: operationsUserId, displayName: 'Operations One', email: 'operations@example.invalid', role: 'leader', joinedAt: now };
  const member = { userId: salesUserId, displayName: 'Sales One', email: 'sales@example.invalid', role: 'member', joinedAt: now };
  const companyId = randomUUID();
  const operationsUnitId = randomUUID();
  const teamId = randomUUID();
  const adminTeams = role === 'operations' ? [
    { teamId: operationsUnitId, name: 'East Operations', unitType: 'operations', organizationKind: 'operations_group', parentTeamId: companyId, parentTeamName: 'Milogin Logistics', depth: 0, childCount: 1, leaderName: 'Operations One', memberCount: 2, pendingInvitationCount: 0, createdAt: now },
    { teamId, name: 'East Sales Team', unitType: 'sales_team', organizationKind: 'sales_team', parentTeamId: companyId, parentTeamName: 'Milogin Logistics', assignmentSourceTeamIds: [operationsUnitId], assignedLeadCount: 6, depth: 0, childCount: 0, leaderName: 'Operations One', memberCount: 2, pendingInvitationCount: 0, createdAt: now },
    { teamId: randomUUID(), name: 'South Sales Team', unitType: 'sales_team', organizationKind: 'sales_team', parentTeamId: companyId, parentTeamName: 'Milogin Logistics', assignmentSourceTeamIds: [], assignedLeadCount: 0, depth: 0, childCount: 0, leaderName: 'Liu Chen', memberCount: 4, pendingInvitationCount: 1, createdAt: now },
    { teamId: randomUUID(), name: 'Key Accounts', unitType: 'sales_team', organizationKind: 'sales_team', parentTeamId: companyId, parentTeamName: 'Milogin Logistics', assignmentSourceTeamIds: [], assignedLeadCount: 0, depth: 0, childCount: 0, leaderName: 'Wang Yue', memberCount: 3, pendingInvitationCount: 0, createdAt: now },
  ] : [];
  return {
    team: { teamId, name: 'East Sales Team', unitType: 'sales_team', memberCount: 2, parentTeamId: operationsUnitId, parentTeamName: 'East Operations', leaderUserId: operationsUserId, leaderName: 'Operations One', version: 1, createdAt: now, members: [leader, member], memberGroups: [] },
    incomingInvitations: [], outgoingInvitations: [], canCreate: false, canAdmin: role === 'operations', isSuperAdmin: false,
    adminTeams,
    organization: { company: { unitId: companyId, kind: 'company', parentUnitId: null, name: 'Milogin Logistics', version: 1 }, visibleUnits: adminTeams.map(item => ({ unitId: item.teamId, kind: item.organizationKind, parentUnitId: item.parentTeamId, name: item.name, version: 1 })) },
  };
}

function detail() {
  return { contact: structuredClone(contact), company: { companyId: 1, name: contact.companyName, domain: null, backcheckData: null, canEdit: false }, activities: [], canEdit: false, canFollowup: false, canAssign: false, mailAvailable: false, mailEvents: [], mailEventLimit: 200 };
}

function monitoringDetail(userId) {
  const member = currentTeamContext.team.members.find(item => item.userId === userId) || currentTeamContext.team.members[0];
  const counts = { contacts: 3, uncontacted: 0, contacted: 1, replied: 1, bounced: 1, autoreply: 0, openActions: 2, overdueActions: 1, importantReplies: 1, openAttention: 1, pendingAssignments: 0, pendingTransfers: 0 };
  const rates = { contactRate: 1, replyRate: 0.33, bounceRate: 0.33, actionRate: 0.67 };
  return {
    scope: 'operations', generatedAt: now, member: { userId: member.userId, displayName: member.displayName, email: member.email, teamId: currentTeamContext.team.teamId, teamName: currentTeamContext.team.name, organizationKind: 'sales_team', counts, rates, stages: { cold: 0, reaching: 1, quoting: 1, trial: 1, cooperating: 0, lost: 0, other: 0 }, lastActivityAt: now, latestImportantReplyAt: now },
    recentActions: [{ actionId: randomUUID(), kind: 'task', title: '回复 Santos 报价', customerId: contact.customerId, customerName: contact.companyName, contactId: contact.contactId, contactName: 'Ana Lima', dueAt: now, occurredAt: now, priority: 'important' }],
    attention: [{ itemId: randomUUID(), memberUserId: member.userId, memberName: member.displayName, customerId: contact.customerId, customerName: contact.companyName, contactId: contact.contactId, contactName: 'Ana Lima', reason: '客户要求今天确认舱位', priority: 'urgent', status: 'open', note: null, updatedAt: now }],
    recentMail: [{ eventId: randomUUID(), contactId: contact.contactId, customerId: contact.customerId, subject: 'Re: Santos rate request', kind: 'reply', direction: 'inbound', occurredAt: now, analysisId: null, classification: null, relevance: null, summary: '客户确认 2x40HQ 报价，等待舱位确认。', signals: [], intent: null, requiresAction: true, nextAction: null, priority: 'important', confidence: null, source: null, analyzerVersion: null }],
  };
}

function grant() {
  const timestamp = Date.now();
  const payload = JSON.stringify({ version: 1, audience: 'prospector-local', issuer: base, issuedAt: new Date(timestamp).toISOString(), expiresAt: new Date(timestamp + 72 * 60 * 60 * 1000).toISOString(), identity: currentIdentity });
  return { payload, signature: sign(null, Buffer.from(payload), privateKey).toString('base64url'), publicKey: createPublicKey(privateKey).export({ format: 'pem', type: 'spki' }).toString() };
}

async function startCenter() {
  center = http.createServer(async (request, response) => {
    let raw = '';
    for await (const part of request) raw += part;
    const body = raw ? JSON.parse(raw) : undefined;
    const url = new URL(request.url, base ?? 'http://127.0.0.1');
    let result;
    if (url.pathname.endsWith('/login') || url.pathname.endsWith('/refresh')) result = ok({ token: randomBytes(32).toString('base64url'), refreshToken: randomBytes(32).toString('base64url'), identity: currentIdentity, expiresAt: new Date(Date.now() + 3600000).toISOString(), offlineAccess: grant() });
    else if (url.pathname.endsWith('/me')) result = ok(currentIdentity);
    else if (url.pathname === '/api/crm/bootstrap') result = ok({ userId: currentIdentity.userId, capabilities: currentIdentity.crmCapabilities, scope: currentIdentity.crmRoles.includes('sales') ? 'own' : 'shared', summary: { mine: 1, pool: 0 }, feedCursor: '0' });
    else if (request.method === 'GET' && url.pathname === '/api/crm/contacts') { counters.contacts++; result = ok({ items: [contact], total: 1 }); }
    else if (request.method === 'GET' && url.pathname === '/api/crm/contacts/1') { assert.equal(url.searchParams.get('customerId'), customerId); counters.details++; result = ok(detail()); }
    else if (request.method === 'GET' && url.pathname === '/api/crm/tasks') { counters.tasks++; result = ok({ items: [task], total: 1 }); }
    else if (request.method === 'GET' && url.pathname === '/api/crm/team-context') { counters.teamContexts++; result = ok(currentTeamContext); }
    else if (request.method === 'GET' && url.pathname.startsWith('/api/crm/teams/')) {
      counters.teamDetails++;
      const requestedId = decodeURIComponent(url.pathname.split('/').pop());
      const selected = currentTeamContext.adminTeams.find(team => team.teamId === requestedId);
      const baseTeam = currentTeamContext.team;
      const team = selected && selected.teamId !== baseTeam.teamId
        ? { ...baseTeam, teamId: selected.teamId, name: selected.name, unitType: selected.unitType, parentTeamId: selected.parentTeamId, parentTeamName: selected.parentTeamName, members: baseTeam.members }
        : baseTeam;
      result = ok({ team, outgoingInvitations: [], children: currentTeamContext.adminTeams.filter(item => (item.assignmentSourceTeamIds || []).includes(team.teamId)) });
    }
    else if (request.method === 'GET' && url.pathname.startsWith('/api/crm/team-monitoring/members/')) { counters.teamMonitoring++; result = ok(monitoringDetail(decodeURIComponent(url.pathname.split('/').pop()))); }
    else if (request.method === 'GET' && url.pathname === '/api/crm/team-invite-candidates') { counters.candidates++; result = ok({ items: [{ userId: randomUUID(), displayName: 'Wang Yue', email: 'wang.yue@example.invalid' }], total: 1 }); }
    else if (url.pathname === '/api/crm/notifications') result = ok({ items: [], nextCursor: '0', hasMore: false });
    else if (url.pathname.endsWith('/logout')) result = ok(undefined);
    else result = fail('NOT_FOUND', `Fixture endpoint absent: ${url.pathname}`);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(result));
  });
  await new Promise(resolve => center.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${center.address().port}`;
}

async function runScenario(name, identity, checks, { initialPage = 'workbench' } = {}) {
  currentIdentity = identity;
  const profile = mkdtempSync(path.join(tmpdir(), `prospector-team-${name}-`));
  const pageErrors = [];
  let app, page;
  try {
    const env = { ...process.env, SMOKE_PROFILE: profile, NODE_PATH: path.join(root, 'node_modules'), NODE_OPTIONS: '' };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'PROSPECTOR_DEV_PROFILE', 'PROSPECTOR_DEV_AUTOLOGIN']) delete env[key];
    app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [bundle], cwd: root, env });
    page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false); win.show(); win.focus(); });
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => pageErrors.push(error.message));
    const login = await page.evaluate(({ base, email }) => window.api.invoke('online:login', { baseUrl: base, email, password: 'SyntheticFixture1', remember: true }), { base, email: identity.email });
    assert.equal(login.ok, true, login.error?.message);
    const teamNav = page.getByText('团队', { exact: true }).first();
    await teamNav.waitFor();
    await teamNav.click();
    await page.locator('.team-workspace-page').waitFor();
    if (initialPage === 'workbench') await page.locator('.personal-action-row').waitFor();
    else if (initialPage === 'setup') await page.locator('.team-setup-view').waitFor();
    else await page.locator('.team-admin-view').waitFor();
    await page.waitForFunction(() => !document.querySelector('.ant-message-notice'), null, { timeout: 10000 }).catch(() => null);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 1000));
    await page.waitForTimeout(200);
    const wide = await page.evaluate(() => { const root = document.querySelector('.team-workspace-page'); return { clientWidth: root?.clientWidth, scrollWidth: root?.scrollWidth }; });
    assert.equal(wide.scrollWidth, wide.clientWidth);
    if (initialPage === 'workbench') await page.screenshot({ path: path.join(designs, `${name}-workbench-1440.png`) });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1040, 720));
    await page.waitForTimeout(200);
    const narrow = await page.evaluate(() => { const root = document.querySelector('.team-workspace-page'); return { clientWidth: root?.clientWidth, scrollWidth: root?.scrollWidth }; });
    assert.equal(narrow.scrollWidth, narrow.clientWidth);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(824, 720));
    await page.waitForTimeout(200);
    const compact = await page.evaluate(() => { const root = document.querySelector('.team-workspace-page'); return { clientWidth: root?.clientWidth, scrollWidth: root?.scrollWidth }; });
    assert.equal(compact.scrollWidth, compact.clientWidth);
    await page.screenshot({ path: path.join(designs, `${name}-824.png`) });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 1000));
    await page.waitForTimeout(200);
    await checks(page, app);
    if (initialPage !== 'workbench') {
      assert.deepEqual(pageErrors, []);
      return { name, wide, narrow, compact, pageErrors };
    }
    if (await page.locator('.personal-action-row').count() === 0) {
      await page.getByRole('button', { name: '个人' }).click();
    }
    const row = page.locator('.personal-action-row').first();
    await row.waitFor();
    await row.click();
    await page.locator('.contact-detail-tabs').waitFor();
    await page.screenshot({ path: path.join(designs, `${name}-customer-detail-1440.png`) });
    assert.ok(counters.details >= 1);
    assert.deepEqual(pageErrors, []);
    return { name, wide, narrow, compact, pageErrors };
  } catch (error) {
    if (page) console.error(JSON.stringify({ scenario: name, url: page.url(), body: (await page.locator('body').innerText().catch(() => '')).slice(0, 2000), pageErrors }, null, 2));
    throw error;
  } finally {
    if (app) await app.close();
    assert.equal(path.dirname(path.resolve(profile)).toLowerCase(), path.resolve(tmpdir()).toLowerCase());
    rmSync(profile, { recursive: true, force: true });
  }
}

(async () => {
  try {
    await startCenter();
    const before = { ...counters };
    currentTeamContext = teamContext('sales');
    const sales = await runScenario('prospector-team-sales', { userId: salesUserId, displayName: 'Sales One', email: 'sales@example.invalid', emailVerified: true, identityAdmin: false, crmRoles: ['sales'], crmCapabilities: ['leads.claim', 'leads.develop'] }, async page => {
      assert.deepEqual(await page.locator('.team-section-tabs button').allTextContents(), ['个人', '我的团队', '团队管理']);
      assert.equal(await page.locator('.personal-task-panel').count(), 1);
    });
    const salesTasks = counters.tasks - before.tasks;
    assert.ok(salesTasks >= 1);

    currentIdentity = { userId: operationsUserId, displayName: 'Operations One', email: 'operations@example.invalid', emailVerified: true, identityAdmin: false, crmRoles: ['operations'], crmCapabilities: ['leads.assign', 'leads.develop', 'members.read'] };
    currentTeamContext = teamContext('operations');
    const beforeOps = { ...counters };
    const operations = await runScenario('prospector-team-operations', currentIdentity, async (page, app) => {
      assert.deepEqual(await page.locator('.team-section-tabs button').allTextContents(), ['个人', '我的团队', '监控', '团队管理', '绩效']);
      assert.equal(await page.locator('.personal-task-panel').count(), 0);
      await page.locator('.team-admin-workspace.is-directory').waitFor();
      assert.equal(await page.locator('.team-admin-canvas-viewport').count(), 0);
      assert.match(await page.locator('.team-admin-stat-grid').innerText(), /成员席位/);
      const teamSearch = page.getByRole('textbox', { name: '搜索团队、负责人或成员' });
      await teamSearch.fill('Key Accounts');
      assert.equal(await page.locator('.team-admin-tree-row').count(), 1);
      await teamSearch.fill('');
      await page.screenshot({ path: path.join(designs, 'prospector-team-operations-admin-1440.png') });
      await page.locator('.team-admin-tree-row').first().click();
      await page.locator('.team-admin-team-head').waitFor();
      assert.ok(counters.teamDetails >= 1);
      await page.screenshot({ path: path.join(designs, 'prospector-team-operations-admin-detail-1440.png') });
      const memberRow = page.locator('.team-admin-member-tree-row').first();
      await memberRow.waitFor();
      await memberRow.click();
      await page.locator('.team-collaboration-log').waitFor();
      assert.match(await page.locator('.team-collaboration-log').innerText(), /暂无协作动态/);
      assert.doesNotMatch(await page.locator('.team-admin-overview-aside').innerText(), /触达率|回复率|最近活动|开放动作|关注项/);
      assert.equal(await page.locator('.team-collaboration-tools button:disabled').count(), 4);
      assert.equal(await page.locator('.team-collaboration-composer textarea:disabled').count(), 1);
      await page.screenshot({ path: path.join(designs, 'prospector-team-operations-collaboration-1440.png') });
      await page.locator('.team-admin-tree-row').first().click();
      await page.locator('.team-admin-team-head').waitFor();
      await page.getByRole('button', { name: '返回团队树' }).click();
      await page.getByRole('button', { name: '团队画布' }).click();
      const canvas = page.locator('.team-admin-canvas-viewport');
      await canvas.waitFor();
      assert.equal(await page.locator('.team-admin-org-node').count(), 4);
      assert.equal(await page.locator('.team-admin-org-node.is-superadmin').count(), 0);
      assert.equal(await page.locator('.team-admin-org-node.is-company').count(), 0);
      await page.screenshot({ path: path.join(designs, 'prospector-team-operations-admin-canvas-1440.png') });
      await page.locator('.team-admin-org-node-main').filter({ hasText: 'East Operations' }).click();
      const expandedMember = page.locator('.team-admin-org-node.is-expanded .team-admin-org-member-row').first();
      await expandedMember.waitFor();
      await page.screenshot({ path: path.join(designs, 'prospector-team-operations-admin-canvas-expanded-1440.png') });
      assert.equal(await expandedMember.evaluate(node => node.tagName), 'DIV');
      assert.equal(await page.locator('.team-monitoring-member-detail').count(), 0);
      await page.screenshot({ path: path.join(designs, 'prospector-team-operations-admin-member-1440.png') });
      await page.getByRole('button', { name: '收起 East Operations' }).click();
      assert.equal(await page.locator('.team-admin-org-node').count(), 3);
      await page.getByRole('button', { name: '展开 East Operations' }).click();
      assert.equal(await page.locator('.team-admin-org-node').count(), 4);
      const canvasBox = await canvas.boundingBox();
      assert.ok(canvasBox);
      const zoomBefore = await page.locator('.team-admin-canvas-actions span').innerText();
      await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
      await page.mouse.wheel(0, -240);
      await page.waitForTimeout(120);
      assert.notEqual(await page.locator('.team-admin-canvas-actions span').innerText(), zoomBefore);
      const transformBefore = await page.locator('.team-admin-canvas-stage').evaluate(node => node.style.transform);
      await page.mouse.move(canvasBox.x + canvasBox.width - 70, canvasBox.y + canvasBox.height - 70);
      await page.mouse.down();
      await page.mouse.move(canvasBox.x + canvasBox.width - 140, canvasBox.y + canvasBox.height - 120, { steps: 4 });
      await page.mouse.up();
      const transformAfter = await page.locator('.team-admin-canvas-stage').evaluate(node => node.style.transform);
      assert.notEqual(transformAfter, transformBefore);
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1040, 720));
      await page.waitForTimeout(200);
      const adminNarrow = await page.evaluate(() => { const root = document.querySelector('.team-admin-view'); return { clientWidth: root?.clientWidth, scrollWidth: root?.scrollWidth }; });
      assert.equal(adminNarrow.scrollWidth, adminNarrow.clientWidth);
      await page.getByRole('button', { name: '适配视图' }).click();
      await page.waitForTimeout(120);
      await page.screenshot({ path: path.join(designs, 'prospector-team-operations-admin-canvas-1040.png') });
      await page.getByRole('button', { name: '团队列表' }).click();
      await page.locator('.team-admin-workspace.is-directory').waitFor();
      await page.locator('.team-admin-tree-row').first().click();
      await page.locator('.team-admin-team-head').waitFor();
      await page.locator('.team-admin-member-tree-row').first().click();
      await page.locator('.team-collaboration-log').waitFor();
      const collaborationNarrow = await page.evaluate(() => { const root = document.querySelector('.team-admin-view'); return { clientWidth: root?.clientWidth, scrollWidth: root?.scrollWidth }; });
      assert.equal(collaborationNarrow.scrollWidth, collaborationNarrow.clientWidth);
      await page.screenshot({ path: path.join(designs, 'prospector-team-operations-admin-1040.png') });
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 1000));
      await page.waitForTimeout(200);
    }, { initialPage: 'management' });
    assert.equal(counters.tasks, beforeOps.tasks);

    const invitee = { userId: 'invitee-1', displayName: 'Invitee One', email: 'invitee@example.invalid', emailVerified: true, identityAdmin: false, crmRoles: ['sales'], crmCapabilities: ['leads.claim', 'leads.develop'] };
    currentIdentity = invitee;
    currentTeamContext = { team: null, incomingInvitations: [], outgoingInvitations: [], canCreate: false, canAdmin: false, isSuperAdmin: false, adminTeams: [] };
    const invitation = { invitationId: randomUUID(), teamId: randomUUID(), teamName: 'East Sales Team', inviterUserId: operationsUserId, inviterName: 'Operations One', inviteeUserId: invitee.userId, inviteeName: invitee.displayName, status: 'pending', version: 1, createdAt: now, decidedAt: null, canAccept: true, canDecline: true, canCancel: false };
    const invitationScenario = await runScenario('prospector-team-invitation', invitee, async (page, app) => {
      assert.equal(await page.locator('.team-invitation-row').count(), 0);
      currentTeamContext = { ...currentTeamContext, incomingInvitations: [invitation] };
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      const started = Date.now();
      await page.locator('.team-invitation-row').waitFor({ timeout: 3500 });
      assert.match(await page.locator('.team-invitation-row').innerText(), /East Sales Team/);
      assert.ok(Date.now() - started < 3500);
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(824, 720));
      await page.waitForTimeout(200);
      const compact = await page.evaluate(() => { const root = document.querySelector('.team-workspace-page'); return { clientWidth: root?.clientWidth, scrollWidth: root?.scrollWidth }; });
      assert.equal(compact.scrollWidth, compact.clientWidth);
      await page.screenshot({ path: path.join(designs, 'prospector-team-invitation-live-824.png') });
    }, { initialPage: 'setup' });
    console.log(JSON.stringify({ ok: true, counters, scenarios: [sales, operations, invitationScenario] }, null, 2));
  } catch (error) {
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    if (center) await new Promise(resolve => center.close(resolve));
  }
})();
