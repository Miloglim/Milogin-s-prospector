import type { AssistantReminderFacts, AssistantReminderKind } from '../../shared/assistant';

export interface AssistantCandidate {
  id: string;
  signature: string;
  kind?: AssistantReminderKind;
  title: string;
  detail: string;
  target: string;
  priority: 1 | 2 | 3;
  facts?: AssistantReminderFacts;
}

export function assistantDue(lastCheckedAt: string | null, intervalMinutes: number, now = Date.now()): boolean {
  if (!intervalMinutes || intervalMinutes < 1) return false;
  const last = lastCheckedAt ? Date.parse(lastCheckedAt) : Number.NaN;
  if (!Number.isFinite(last)) return true;
  return now - last >= intervalMinutes * 60_000;
}

export function fallbackAssistantSelection(candidates: readonly AssistantCandidate[], max = 4): AssistantCandidate[] {
  return [...candidates].sort((left, right) => left.priority - right.priority).slice(0, max);
}

/** AI may only pick candidate ids; titles are re-written but bounded and targets always come from the candidate. */
export function assistantSelection(value: unknown, candidates: readonly AssistantCandidate[], max = 4): AssistantCandidate[] {
  const byId = new Map(candidates.map(candidate => [candidate.id, candidate]));
  const raw = value && typeof value === 'object' && !Array.isArray(value) && Array.isArray((value as { items?: unknown }).items)
    ? (value as { items: unknown[] }).items : null;
  if (!raw) return fallbackAssistantSelection(candidates, max);
  if (raw.length === 0) return [];
  const items = raw;
  const seen = new Set<string>();
  const selected: AssistantCandidate[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const id = typeof row.id === 'string' ? row.id : '';
    const candidate = byId.get(id);
    if (!candidate || seen.has(id)) continue;
    const title = typeof row.title === 'string' ? row.title.trim().slice(0, 40) : '';
    const detail = typeof row.detail === 'string' ? row.detail.trim().slice(0, 80) : '';
    seen.add(id);
    selected.push({ ...candidate, title: title || candidate.title, detail: detail || candidate.detail });
    if (selected.length >= max) break;
  }
  return selected.length ? selected : fallbackAssistantSelection(candidates, max);
}
