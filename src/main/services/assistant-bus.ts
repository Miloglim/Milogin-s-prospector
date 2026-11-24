// Assistant source changes are coalesced in the main process. Event producers do
// not know how reminders are computed, and a burst of mail/task writes produces
// one refresh instead of one model or database pass per row.

type WakeHandler = (reason: string) => void | Promise<void>;

export const ASSISTANT_WAKE_DEBOUNCE_MS = 600;

let handler: WakeHandler | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const reasons = new Set<string>();

export function initAssistantBus(next: WakeHandler): void {
  handler = next;
  cancelAssistantWake();
}

export function wakeAssistant(reason = 'data'): void {
  if (!handler) return;
  reasons.add(reason);
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    const current = handler;
    if (!current) return;
    const batch = [...reasons].sort().join(',');
    reasons.clear();
    void current(batch);
  }, ASSISTANT_WAKE_DEBOUNCE_MS);
}

export function cancelAssistantWake(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  reasons.clear();
}
