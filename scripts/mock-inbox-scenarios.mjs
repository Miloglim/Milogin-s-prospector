import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MESSAGE_PREFIX = 'mock.scenario.';
const DAY_MS = 86_400_000;

if (!process.versions.electron) {
  const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const result = spawnSync(electron, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  process.exit(result.status ?? 1);
}

const Database = require('better-sqlite3');

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function fail(message) {
  process.stderr.write(`[mock.inbox] ${message}\n`);
  process.exit(1);
}

function resolveProfile() {
  const explicit = arg('profile') || process.env.PROSPECTOR_DEV_PROFILE || '';
  if (explicit) return path.resolve(explicit);
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'prospecting-email-dev');
}

function assertDevelopmentProfile(profile) {
  const normalized = path.resolve(profile).toLowerCase();
  const isDev = normalized.includes(`${path.sep}prospecting-email-dev`) || normalized.includes(`${path.sep}.work${path.sep}`);
  if (!isDev || normalized.endsWith(`${path.sep}prospecting-email`)) {
    fail(`拒绝写入非开发 profile：${profile}`);
  }
}

function resolveAccount(profile) {
  const accountsRoot = path.join(profile, 'accounts');
  if (!fs.existsSync(accountsRoot)) fail(`找不到开发账号目录：${accountsRoot}`);
  const requested = arg('account');
  const candidates = fs.readdirSync(accountsRoot)
    .map(name => path.join(accountsRoot, name))
    .filter(dir => fs.existsSync(path.join(dir, 'data', 'prospector.db')))
    .map(dir => ({ dir, modified: fs.statSync(path.join(dir, 'data', 'prospector.db')).mtimeMs }))
    .sort((a, b) => b.modified - a.modified);
  if (!candidates.length) fail('开发 profile 下没有可写的账号数据库');
  if (!requested) return candidates[0].dir;
  const match = candidates.find(item => item.dir === path.resolve(requested) || path.basename(item.dir).startsWith(requested));
  if (!match) fail(`找不到匹配的开发账号：${requested}`);
  return match.dir;
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

const SCENARIOS = [
  {
    key: 'quote_request', from: 'amelia.route@jade-logistics.mock', name: 'Amelia Route', company: 'Mock Jade Logistics',
    subject: '[MOCK:quote_request] RFQ Shanghai to Rotterdam', preview: 'Please quote 2x40HQ Shanghai to Rotterdam, cargo ready next week.',
    classification: 'replied', myRole: 'to', daysAgo: 1,
    reply: 'Thanks Amelia, we are checking the rate and will revert with the best offer today.',
  },
  {
    key: 'schedule_request', from: 'jonas.berg@nordic-freight.mock', name: 'Jonas Berg', company: 'Mock Nordic Freight',
    subject: '[MOCK:schedule_request] Sailing and cut-off next week', preview: 'Please confirm the sailing and cut-off for Ningbo to Oslo next week.',
    classification: 'replied', myRole: 'to', daysAgo: 2,
    reply: 'Jonas, the carrier options and cut-off are being confirmed, reply shortly.',
  },
  {
    key: 'order_followup', from: 'lena.fischer@rhine-parts.mock', name: 'Lena Fischer', company: 'Mock Rhine Parts',
    subject: '[MOCK:order_followup] Any update on our booking?', preview: 'Any update on our booking? We need the ETD for production planning.',
    classification: 'replied', myRole: 'to', daysAgo: 3,
    reply: 'Lena, we are checking with the carrier and will confirm the ETD today.',
  },
  {
    key: 'complaint', from: 'diego.tan@pacific-cargo.mock', name: 'Diego Tan', company: 'Mock Pacific Cargo',
    subject: '[MOCK:complaint] Shipment delay without notice', preview: 'We were not informed about the delay. This is affecting our customer.',
    classification: 'replied', myRole: 'to', daysAgo: 0.5,
    reply: 'Diego, I am checking the delay reason with the carrier and will call you within the hour.',
  },
  {
    key: 'cooperation', from: 'sofia.lopez@bluewave.mock', name: 'Sofia Lopez', company: 'Mock BlueWave Logistics',
    subject: '[MOCK:cooperation] Cooperation on Spain import lanes', preview: 'We would like to explore cooperation on Spain import lanes.',
    classification: 'replied', myRole: 'to', daysAgo: 4,
  },
  {
    key: 'reply_needed', from: 'rafael.souza@coral-import.mock', name: 'Rafael Souza', company: 'Mock Coral Import',
    subject: '[MOCK:reply_needed] Could you clarify the destination fee?', preview: 'Could you clarify this point? Is the destination fee included?',
    classification: 'replied', myRole: 'to', daysAgo: 5,
  },
  {
    key: 'internal_request', from: 'colleague@yqn.com', name: 'Internal Colleague', company: '',
    subject: '[MOCK:internal_request] 请确认客户运价', preview: '请确认客户运价后再回复我，今天需要给客户。',
    classification: 'replied', myRole: 'to', daysAgo: 1,
  },
  {
    key: 'rate_update', from: 'rate.desk@yqn.com', name: 'Rate Desk', company: '',
    subject: '[MOCK:rate_update] 阳明海运更新 WCSA 运价', preview: '阳明海运更新WCSA的FAK运价，有效期2026年11月13日至17日，新增Caldera为POD。',
    classification: 'replied', myRole: 'to', daysAgo: 2,
  },
  {
    key: 'marketing', from: 'newsletter@vendor.test', name: 'Vendor Newsletter', company: '',
    subject: '[MOCK:marketing] Weekly market newsletter', preview: 'Weekly market update. Unsubscribe from this list.',
    classification: 'other', myRole: 'to', daysAgo: 3,
  },
  {
    key: 'invoice', from: 'billing@vendor.test', name: 'Billing', company: '',
    subject: '[MOCK:invoice] Invoice overdue', preview: 'Invoice INV-2026-118 is overdue. Payment due today.',
    classification: 'other', myRole: 'to', daysAgo: 1,
  },
  {
    key: 'bounce', from: 'mailer-daemon@vendor.test', name: 'Mail Delivery', company: '',
    subject: '[MOCK:bounce] Delivery failed', preview: 'The recipient address was rejected. Delivery failed.',
    classification: 'bounce', myRole: 'to', daysAgo: 0.2,
  },
  {
    key: 'autoreply', from: 'auto-reply@coral-import.mock', name: 'Out of Office', company: '',
    subject: '[MOCK:autoreply] Out of office', preview: 'This is an automated out-of-office response.',
    classification: 'autoreply', myRole: 'to', daysAgo: 2,
  },
  {
    key: 'cc_only', from: 'buyer@orchid-trading.mock', name: 'Mei Lim', company: 'Mock Orchid Trading',
    subject: '[MOCK:cc_only] Internal handover copy', preview: 'You are copied for reference only.',
    classification: 'replied', myRole: 'cc', daysAgo: 4,
  },
  {
    key: 'ambiguous', from: 'erik.nilsson@cedar-home.mock', name: 'Erik Nilsson', company: 'Mock Cedar Home',
    subject: '[MOCK:ambiguous] Quick question', preview: 'Let us know what you think when you have a moment.',
    classification: 'replied', myRole: 'to', daysAgo: 6,
  },
];

function ensureContact(db, email, name, company) {
  if (!company) return null;
  const [firstName, ...rest] = name.split(' ');
  let companyRow = db.prepare('SELECT id FROM companies WHERE name=?').get(company);
  if (!companyRow) {
    const info = db.prepare('INSERT INTO companies(name,domain,country) VALUES(?,?,?)').run(company, email.split('@')[1] || null, 'Mock');
    companyRow = { id: Number(info.lastInsertRowid) };
  }
  let contact = db.prepare('SELECT id FROM contacts WHERE email=?').get(email);
  if (!contact) {
    const info = db.prepare('INSERT INTO contacts(email,company_id,first_name,last_name,stage,status,source) VALUES(?,?,?,?,?,?,?)')
      .run(email, companyRow.id, firstName, rest.join(' ') || null, 'f1', 'contacted', 'mock-scenario');
    contact = { id: Number(info.lastInsertRowid) };
  }
  return contact.id;
}

function removeMockRows(db, bodiesDir) {
  const rows = db.prepare("SELECT id,message_id FROM inbox_messages WHERE message_id LIKE ?").all(`${MESSAGE_PREFIX}%`);
  if (!rows.length) return 0;
  const ids = rows.map(row => row.id);
  const placeholders = ids.map(() => '?').join(',');
  const tables = ['inbox_mail_analyses', 'inbox_todo_states', 'inbox_pinned_messages', 'inbox_message_labels', 'inbox_label_candidates', 'inbox_bounce_matches'];
  const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  for (const table of tables) {
    if (names.has(table)) db.prepare(`DELETE FROM ${table} WHERE message_id IN (${placeholders})`).run(...ids);
  }
  if (names.has('inbox_seen_outbox')) db.prepare('DELETE FROM inbox_seen_outbox WHERE message_id LIKE ?').run(`${MESSAGE_PREFIX}%`);
  for (const row of rows) {
    const file = path.join(bodiesDir, `${row.id}.html`);
    if (fs.existsSync(file)) fs.rmSync(file);
  }
  db.prepare(`DELETE FROM inbox_messages WHERE id IN (${placeholders})`).run(...ids);
  return rows.length;
}

function bodyHtml(subject, preview) {
  return `<!doctype html><html><body><p><strong>${subject.replace(/[<>&]/g, '')}</strong></p><p>${preview.replace(/[<>&]/g, '')}</p><p>Mock scenario generated for the inbox full-chain test.</p></body></html>`;
}

const profile = resolveProfile();
assertDevelopmentProfile(profile);
const accountDir = resolveAccount(profile);
const dbFile = path.join(accountDir, 'data', 'prospector.db');
const bodiesDir = path.join(accountDir, 'data', 'bodies');
fs.mkdirSync(bodiesDir, { recursive: true });
const db = new Database(dbFile);
db.pragma('busy_timeout = 5000');
db.function('search_latin', { deterministic: true }, text => String(text ?? '').replace(/[^\p{Script=Latin}\p{N}\s]/gu, ' '));

let account = db.prepare('SELECT id,email FROM email_accounts ORDER BY id LIMIT 1').get();
if (!account) {
  const info = db.prepare("INSERT INTO email_accounts(email,provider,encrypted_pass,display_name,is_active) VALUES(?,?,?,?,1)")
    .run('mock.inbox@example.test', 'smtp', '', 'Mock Inbox');
  account = { id: Number(info.lastInsertRowid), email: 'mock.inbox@example.test' };
}

if (flag('reset')) {
  const removed = removeMockRows(db, bodiesDir);
  process.stdout.write(`[mock.inbox] 已清除 ${removed} 封旧 mock 邮件\n`);
}

const insert = db.prepare(`INSERT INTO inbox_messages
  (account_id,message_id,from_email,from_name,subject,body_preview,classification,"to",cc,my_role,matched_contact_id,is_read,received_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const output = [];
const run = db.transaction(() => {
  for (const scenario of SCENARIOS) {
    const contactId = ensureContact(db, scenario.from, scenario.name, scenario.company);
    const receivedAt = isoDaysAgo(scenario.daysAgo);
    const inbound = insert.run(
      account.id, `${MESSAGE_PREFIX}${scenario.key}.in@example.test`, scenario.from, scenario.name,
      scenario.subject, scenario.preview, scenario.classification, account.email, null, scenario.myRole,
      contactId, 0, receivedAt,
    );
    const inboundId = Number(inbound.lastInsertRowid);
    fs.writeFileSync(path.join(bodiesDir, `${inboundId}.html`), bodyHtml(scenario.subject, scenario.preview));
    let replyId = null;
    if (scenario.reply) {
      const replySubject = scenario.subject.startsWith('Re:') ? scenario.subject : `Re: ${scenario.subject}`;
      const reply = insert.run(
        account.id, `${MESSAGE_PREFIX}${scenario.key}.out@example.test`, account.email, 'Mock Self',
        replySubject, scenario.reply, 'sent', scenario.from, null, 'sender', contactId, 1,
        isoDaysAgo(Math.max(0, scenario.daysAgo - 0.1)),
      );
      replyId = Number(reply.lastInsertRowid);
      fs.writeFileSync(path.join(bodiesDir, `${replyId}.html`), bodyHtml(replySubject, scenario.reply));
    }
    output.push({ scenario: scenario.key, inboundId, replyId, from: scenario.from });
  }
});
run();

process.stdout.write(`[mock.inbox] profile=${profile}\n`);
process.stdout.write(`[mock.inbox] account=${account.email} dir=${accountDir}\n`);
for (const row of output) {
  process.stdout.write(`[mock.inbox] ${row.scenario.padEnd(16)} in=${String(row.inboundId).padStart(3)} out=${row.replyId ?? '-'} from=${row.from}\n`);
}
db.close();
