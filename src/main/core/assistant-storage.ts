import { randomUUID } from 'node:crypto';
import { getRawDb } from '../db';
import {
  ASSISTANT_DEFAULT_CHECKS, ASSISTANT_DEFAULT_INTERVAL_MINUTES,
  type AssistantChecks, type AssistantReminder, type AssistantSettings,
} from '../../shared/assistant';
import type { AssistantCandidate } from './assistant';

const DISMISS_HOLD_MS = 72 * 60 * 60 * 1000;
const REMINDER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const ASSISTANT_DDL = `
CREATE TABLE IF NOT EXISTS assistant_reminders (
  reminder_id TEXT PRIMARY KEY,
  signature TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  target TEXT NOT NULL,
  kind TEXT,
  facts_json TEXT NOT NULL DEFAULT '{}',
  priority INTEGER NOT NULL DEFAULT 3,
  source TEXT NOT NULL DEFAULT 'rule',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  dismissed_at TEXT,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_assistant_reminders_open
  ON assistant_reminders(dismissed_at, priority, created_at DESC);
CREATE TABLE IF NOT EXISTS assistant_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 1,
  interval_minutes INTEGER NOT NULL DEFAULT ${ASSISTANT_DEFAULT_INTERVAL_MINUTES},
  checks_json TEXT NOT NULL DEFAULT '${JSON.stringify(ASSISTANT_DEFAULT_CHECKS)}',
  last_checked_at TEXT,
  last_status TEXT,
  last_error TEXT
);
INSERT OR IGNORE INTO assistant_state(id) VALUES(1);
`;

interface StateRow {
  enabled: number; interval_minutes: number; checks_json: string;
  last_checked_at: string | null; last_status: string | null; last_error: string | null;
}

function stateRow(): StateRow {
  return getRawDb().prepare('SELECT enabled,interval_minutes,checks_json,last_checked_at,last_status,last_error FROM assistant_state WHERE id=1').get() as StateRow;
}

function checks(value: string): AssistantChecks {
  try {
    const parsed = JSON.parse(value) as Partial<AssistantChecks>;
    return {
      mail: parsed.mail !== false, task: parsed.task !== false,
      quoteReview: parsed.quoteReview !== false, stalled: parsed.stalled !== false,
    };
  } catch { /* corrupted settings fall back to defaults rather than blocking the assistant */ return { ...ASSISTANT_DEFAULT_CHECKS }; }
}

export function assistantSettings(): AssistantSettings {
  const row = stateRow();
  return {
    enabled: row.enabled === 1,
    intervalMinutes: Number.isSafeInteger(row.interval_minutes) && row.interval_minutes >= 1 ? row.interval_minutes : ASSISTANT_DEFAULT_INTERVAL_MINUTES,
    checks: checks(row.checks_json),
  };
}

export function saveAssistantSettings(patch: Partial<AssistantSettings>): AssistantSettings {
  const current = assistantSettings();
  const next: AssistantSettings = {
    enabled: patch.enabled ?? current.enabled,
    intervalMinutes: patch.intervalMinutes ?? current.intervalMinutes,
    checks: { ...current.checks, ...(patch.checks ?? {}) },
  };
  getRawDb().prepare('UPDATE assistant_state SET enabled=?,interval_minutes=?,checks_json=? WHERE id=1')
    .run(next.enabled ? 1 : 0, next.intervalMinutes, JSON.stringify(next.checks));
  return next;
}

export function assistantState(): { lastCheckedAt: string | null; lastError: string | null } {
  const row = stateRow();
  return { lastCheckedAt: row.last_checked_at, lastError: row.last_error };
}

export function markAssistantRun(status: 'ai' | 'rule' | 'empty' | 'failed', error: string | null): void {
  getRawDb().prepare("UPDATE assistant_state SET last_checked_at=?,last_status=?,last_error=? WHERE id=1")
    .run(new Date().toISOString(), status, error);
}

export function listAssistantReminders(now = Date.now()): AssistantReminder[] {
  const rows = getRawDb().prepare(`SELECT reminder_id,signature,title,detail,target,kind,facts_json,priority,source,created_at,expires_at
    FROM assistant_reminders WHERE dismissed_at IS NULL ORDER BY priority ASC, created_at DESC`).all() as Array<Record<string, unknown>>;
  return rows.filter(row => !row.expires_at || Date.parse(String(row.expires_at)) > now).map(row => {
    let facts: AssistantReminder['facts'];
    try { facts = row.facts_json ? JSON.parse(String(row.facts_json)) as AssistantReminder['facts'] : undefined; }
    catch { facts = undefined; /* 损坏的 facts 不阻塞提醒显示 */ }
    return {
      reminderId: String(row.reminder_id), kind: row.kind === 'mail' || row.kind === 'quote' || row.kind === 'task' || row.kind === 'followup' ? row.kind : undefined,
      title: String(row.title), detail: String(row.detail),
      target: String(row.target), priority: (Number(row.priority) === 1 ? 1 : Number(row.priority) === 2 ? 2 : 3) as 1 | 2 | 3,
      source: row.source === 'ai' ? 'ai' as const : 'rule' as const, createdAt: String(row.created_at), facts,
    };
  });
}

export function saveAssistantReminders(items: readonly AssistantCandidate[], source: 'ai' | 'rule', now = Date.now()): AssistantReminder[] {
  const db = getRawDb();
  const expires = new Date(now + REMINDER_TTL_MS).toISOString();
  const signatures = new Set(items.map(item => item.signature));
  const tx = db.transaction(() => {
    const dismissed = db.prepare('SELECT signature FROM assistant_reminders WHERE dismissed_at IS NOT NULL AND dismissed_at > ?')
      .all(new Date(now - DISMISS_HOLD_MS).toISOString()) as Array<{ signature: string }>;
    const hold = new Set(dismissed.map(row => row.signature));
    for (const item of items) {
      if (hold.has(item.signature)) continue;
      db.prepare(`INSERT INTO assistant_reminders(reminder_id,signature,title,detail,target,kind,facts_json,priority,source,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(signature) DO UPDATE SET title=excluded.title,detail=excluded.detail,target=excluded.target,
          kind=excluded.kind,facts_json=excluded.facts_json,priority=excluded.priority,source=excluded.source,expires_at=excluded.expires_at,dismissed_at=NULL`)
        .run(randomUUID(), item.signature, item.title, item.detail, item.target, item.kind ?? null, JSON.stringify(item.facts ?? {}), item.priority, source, new Date(now).toISOString(), expires);
    }
    const keep = [...signatures];
    if (keep.length) db.prepare(`DELETE FROM assistant_reminders WHERE dismissed_at IS NULL AND signature NOT IN (${keep.map(() => '?').join(',')})`).run(...keep);
    else db.prepare('DELETE FROM assistant_reminders WHERE dismissed_at IS NULL').run();
    db.prepare('DELETE FROM assistant_reminders WHERE created_at < ?').run(new Date(now - REMINDER_TTL_MS).toISOString());
  });
  tx();
  return listAssistantReminders(now);
}

export function dismissAssistantReminder(reminderId: string): void {
  getRawDb().prepare('UPDATE assistant_reminders SET dismissed_at=? WHERE reminder_id=?').run(new Date().toISOString(), reminderId);
}
