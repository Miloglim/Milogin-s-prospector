// Import a downloaded sample-mail package into a local Prospector profile for development.
// Usage: node scripts/import-sample-mail.mjs <package.json> <prospector.db> [accountId]
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [, , packagePath, dbPath, accountArg] = process.argv;
if (!packagePath || !dbPath) {
  console.error('用法: node scripts/import-sample-mail.mjs <package.json> <prospector.db> [accountId]');
  process.exit(1);
}
const payload = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
if (payload?.version !== 1 || !Array.isArray(payload.messages)) throw new Error('不是可识别的样例包');
const db = new DatabaseSync(dbPath);
// The inbox trigger indexes through this custom function; without it every insert fails.
db.function('search_latin', text => String(text ?? '').replace(/[^\p{Script=Latin}\p{N}\s]/gu, ' '));
const account = accountArg
  ? db.prepare('SELECT id,email FROM email_accounts WHERE id=?').get(Number(accountArg))
  : db.prepare('SELECT id,email FROM email_accounts ORDER BY id LIMIT 1').get();
if (!account) throw new Error('目标库没有邮箱账号，先用该账号登录一次客户端');
const bodyDir = path.join(path.dirname(dbPath), 'bodies');
fs.mkdirSync(bodyDir, { recursive: true });
const preview = html => String(html ?? '').replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().slice(0, 600);
const insert = db.prepare(`INSERT INTO inbox_messages
  (account_id,message_id,from_email,from_name,subject,body_preview,classification,"to",cc,my_role,is_read,received_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
const exists = db.prepare('SELECT id FROM inbox_messages WHERE account_id=? AND message_id=? AND received_at=?');
let inserted = 0, skipped = 0;
db.exec('BEGIN');
try {
  for (const message of payload.messages) {
    if (message.messageId && exists.get(account.id, message.messageId, message.receivedAt)) { skipped++; continue; }
    const result = insert.run(account.id, message.messageId ?? null, String(message.from ?? ''), message.fromName ?? null,
      message.subject ?? '', preview(message.bodyHtml), message.classification ?? null, message.to ?? null, message.cc ?? null,
      'to', message.isRead ? 1 : 0, message.receivedAt ?? new Date().toISOString());
    fs.writeFileSync(path.join(bodyDir, `${result.lastInsertRowid}.html`), String(message.bodyHtml ?? ''), 'utf-8');
    inserted++;
  }
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
} finally {
  db.close();
}
console.log(JSON.stringify({ ok: true, account: account.email, inserted, skipped }));
