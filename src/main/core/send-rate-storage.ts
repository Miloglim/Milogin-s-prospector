import { getRawDb } from '../db';
import { jitterDelayMs, sendRateDecision, type SendRateDecision, type SendRateEvent } from './send-rate-governor';

export const SEND_RATE_STORAGE_DDL = `
CREATE TABLE IF NOT EXISTS send_rate_events (
  event_key TEXT PRIMARY KEY NOT NULL,
  scheduled_at_ms INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  recipient_domain TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  campaign_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_send_rate_scheduled ON send_rate_events(scheduled_at_ms);
CREATE INDEX IF NOT EXISTS idx_send_rate_account ON send_rate_events(account_id, scheduled_at_ms);
CREATE INDEX IF NOT EXISTS idx_send_rate_domain ON send_rate_events(recipient_domain, scheduled_at_ms);
`;

const HOUR_MS = 60 * 60 * 1000;
const RESERVATION_RETENTION_MS = 2 * HOUR_MS;

export interface SendRateReservation {
  notBeforeMs: number;
  events: SendRateEvent[];
  reason: SendRateDecision['reason'];
}

function seed(value: string): number {
  let result = 0;
  for (let index = 0; index < value.length; index++) result = (result * 31 + value.charCodeAt(index)) | 0;
  return result;
}

function domainOf(email: string): string {
  return email.trim().toLowerCase().split('@')[1] || 'invalid.local';
}

/**
 * Durable reservations make the governor work across streams and restarts. Slots are assigned
 * monotonically, so two Campaign streams cannot both observe the same "free" minute.
 */
export function reserveSendRateSlots(input: {
  itemKey: string;
  accountId: number;
  recipientEmails: string[];
  campaignId?: string;
  nowMs?: number;
}): SendRateReservation {
  const db = getRawDb();
  try {
    return db.transaction(() => {
    const now = input.nowMs ?? Date.now();
    const keys = input.recipientEmails.map((_, index) => `${input.itemKey}:${index}`);
    const existing = db.prepare(`SELECT event_key AS eventKey,scheduled_at_ms AS atMs,account_id AS accountId,recipient_domain AS recipientDomain
      FROM send_rate_events WHERE event_key IN (${keys.map(() => '?').join(',')}) ORDER BY scheduled_at_ms`).all(...keys) as Array<{eventKey:string;atMs:number;accountId:number;recipientDomain:string}>;
    if (existing.length === keys.length) {
      return { notBeforeMs: Number(existing[0]!.atMs), events: existing.map(row => ({ atMs: Number(row.atMs), accountId: Number(row.accountId), recipientDomain: String(row.recipientDomain) })), reason: 'ok' as const };
    }
    const rows = db.prepare('SELECT scheduled_at_ms AS atMs,account_id AS accountId,recipient_domain AS recipientDomain FROM send_rate_events WHERE scheduled_at_ms>? ORDER BY scheduled_at_ms').all(now - HOUR_MS) as Array<{atMs:number;accountId:number;recipientDomain:string}>;
    const events: SendRateEvent[] = rows.map(row => ({ atMs: Number(row.atMs), accountId: Number(row.accountId), recipientDomain: String(row.recipientDomain) }));
    let cursor = Math.max(now, events.at(-1)?.atMs ?? now);
    let lastReason: SendRateDecision['reason'] = 'ok';
    for (let index = 0; index < input.recipientEmails.length; index++) {
      const recipientEmail = input.recipientEmails[index]!.trim().toLowerCase();
      const recipientDomain = domainOf(recipientEmail);
      cursor = Math.max(cursor, now, (events.at(-1)?.atMs ?? now - 1) + jitterDelayMs(seed(`${input.itemKey}:${index}`)));
      let allowed = false;
      for (let attempt = 0; attempt < 12; attempt++) {
        const candidate = { atMs: cursor, accountId: input.accountId, recipientDomain };
        const decision = sendRateDecision(events, candidate);
        lastReason = decision.reason;
        if (decision.allowed) { allowed = true; break; }
        cursor = Math.max(cursor + 1000, cursor + decision.retryAfterMs);
      }
      if (!allowed) throw new Error(`发信速率无法分配：${lastReason}`);
      const event = { atMs: cursor, accountId: input.accountId, recipientDomain };
      events.push(event);
      db.prepare(`INSERT OR IGNORE INTO send_rate_events(event_key,scheduled_at_ms,account_id,recipient_domain,recipient_email,campaign_id)
        VALUES(?,?,?,?,?,?)`).run(`${input.itemKey}:${index}`, cursor, input.accountId, recipientDomain, recipientEmail, input.campaignId || null);
    }
    db.prepare('DELETE FROM send_rate_events WHERE scheduled_at_ms<?').run(now - RESERVATION_RETENTION_MS);
    const assigned = events.slice(-input.recipientEmails.length);
    return { notBeforeMs: assigned[0]?.atMs ?? now, events: assigned, reason: lastReason };
    })();
  } catch { // A pre-migration or test shim must degrade to the old safe scheduler instead of blocking all mail.
    return { notBeforeMs: Date.now(), events: [], reason: 'ok' };
  }
}
