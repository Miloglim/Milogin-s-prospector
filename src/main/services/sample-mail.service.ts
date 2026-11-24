import fs from 'node:fs';
import path from 'node:path';
import { getRawDb } from '../db';
import { DB_PATH } from '../config';

const BODY_DIR = () => path.join(path.dirname(DB_PATH), 'bodies');
const BODY_MAX_BYTES = 200 * 1024;
const PACKAGE_MAX_BYTES = 20 * 1024 * 1024;

export interface SampleMailAccount { id: number; email: string }
export interface SampleMailPreview { accountId: number; accountEmail: string; days: number; available: number; selected: number; bytes: number }
export interface SampleMailMessageRow {
  id: number; message_id: string | null; from_email: string; from_name: string | null;
  subject: string | null; to: string | null; cc: string | null; received_at: string;
  classification: string | null; is_read: number;
}

export function sampleMailAccounts(): SampleMailAccount[] {
  return (getRawDb().prepare('SELECT id, email FROM email_accounts WHERE is_active=1 ORDER BY id').all() as Array<{ id: number; email: string }>)
    .map(row => ({ id: Number(row.id), email: String(row.email) }));
}

function sinceIso(days: number): string {
  return new Date(Date.now() - Math.max(0, days) * 86_400_000).toISOString();
}

function bodyFile(id: number): string { return path.join(BODY_DIR(), `${id}.html`); }

function rowBytes(row: SampleMailMessageRow): number {
  let size = 0;
  try { size = fs.statSync(bodyFile(row.id)).size; } catch { size = (row.subject ?? '').length; }
  return Math.min(size, BODY_MAX_BYTES);
}

export function sampleMailPreview(input: { accountId: number; days: number; limit: number }): SampleMailPreview {
  const accounts = sampleMailAccounts();
  const account = accounts.find(item => item.id === input.accountId) ?? accounts[0];
  if (!account) return { accountId: 0, accountEmail: '', days: input.days, available: 0, selected: 0, bytes: 0 };
  const db = getRawDb();
  const since = sinceIso(input.days);
  const available = Number((db.prepare('SELECT COUNT(*) AS n FROM inbox_messages WHERE account_id=? AND datetime(received_at)>=datetime(?)').get(account.id, since) as { n: number }).n);
  const rows = db.prepare(`SELECT id FROM inbox_messages WHERE account_id=? AND datetime(received_at)>=datetime(?)
    ORDER BY datetime(received_at) DESC LIMIT ?`).all(account.id, since, input.limit) as Array<{ id: number }>;
  const bytes = rows.reduce((total, row) => total + rowBytes({ id: Number(row.id) } as SampleMailMessageRow), 0);
  return { accountId: account.id, accountEmail: account.email, days: input.days, available, selected: rows.length, bytes };
}

const MESSAGE_COLUMNS = `id,message_id,from_email,from_name,subject,"to",cc,received_at,classification,is_read`;

export function buildPackageFromRows(accountEmail: string, rows: SampleMailMessageRow[], note: string, bodyLimit = BODY_MAX_BYTES) {
  const messages: Array<Record<string, unknown>> = [];
  let bytes = 0;
  for (const row of rows) {
    let body = '';
    let truncated = false;
    try {
      const raw = fs.readFileSync(bodyFile(Number(row.id)), 'utf-8');
      truncated = Buffer.byteLength(raw) > bodyLimit;
      body = truncated ? raw.slice(0, bodyLimit) : raw;
    } catch { body = ''; }
    const message = {
      messageId: row.message_id, from: row.from_email, fromName: row.from_name,
      to: row.to, cc: row.cc, subject: row.subject, receivedAt: row.received_at,
      classification: row.classification, isRead: Boolean(row.is_read), truncated, bodyHtml: body,
    };
    const size = Buffer.byteLength(JSON.stringify(message));
    if (bytes + size > PACKAGE_MAX_BYTES && messages.length) break;
    bytes += size; messages.push(message);
  }
  if (!messages.length) throw new Error('所选范围内没有可导出的邮件');
  const exportedAt = new Date().toISOString();
  const payload = JSON.stringify({
    version: 1, accountEmail, exportedAt,
    rangeFrom: rows.map(row => row.received_at).sort()[0] ?? exportedAt, rangeTo: exportedAt, note, messages,
  });
  const filename = `sample-mail-${accountEmail.replace(/[^a-z0-9._-]+/gi, '_')}-${exportedAt.replace(/[:.]/g, '-')}.json`;
  return { accountEmail, filename, count: messages.length, bytes: Buffer.byteLength(payload), base64: Buffer.from(payload).toString('base64'), messageIds: rows.slice(0, messages.length).map(row => Number(row.id)) };
}

export function buildSampleMailPackage(input: { accountId: number; days: number; limit: number; note: string }) {
  const accounts = sampleMailAccounts();
  const account = accounts.find(item => item.id === input.accountId) ?? accounts[0];
  if (!account) throw new Error('本机没有可导出的发信账号');
  const since = sinceIso(input.days);
  const rows = getRawDb().prepare(`SELECT ${MESSAGE_COLUMNS}
    FROM inbox_messages WHERE account_id=? AND datetime(received_at)>=datetime(?)
    ORDER BY datetime(received_at) DESC LIMIT ?`).all(account.id, since, input.limit) as SampleMailMessageRow[];
  return buildPackageFromRows(account.email, rows, input.note);
}

/** Background sync: newest messages that were never uploaded, limited to one account per batch. */
export function autoSampleMailBatch(uploadedIds: number[], limit = 100) {
  const accounts = sampleMailAccounts();
  if (!accounts.length) return null;
  const db = getRawDb();
  const excluded = new Set(uploadedIds);
  const accountIds = new Map(accounts.map(account => [account.id, account.email]));
  // Widen the window past already-uploaded rows so a one-shot run can reach the 1000-message cap.
  const window = Math.min(5000, Math.max(limit * 4, uploadedIds.length + limit));
  const filtered = db.prepare(`SELECT ${MESSAGE_COLUMNS},account_id FROM inbox_messages ORDER BY datetime(received_at) DESC, id DESC LIMIT ?`).all(window) as Array<SampleMailMessageRow & { account_id: number }>;
  const picked = filtered.filter(row => accountIds.has(Number(row.account_id)) && !excluded.has(Number(row.id))).slice(0, limit);
  if (!picked.length) return null;
  const accountEmail = accountIds.get(Number(picked[0]!.account_id))!;
  const sameAccount = picked.filter(row => Number(row.account_id) === Number(picked[0]!.account_id));
  return { accountEmail, rows: sameAccount };
}
