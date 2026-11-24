import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ASSISTANT_CHANNELS, type AssistantReminder, type AssistantSettings, type AssistantSnapshot } from '../../shared/assistant';
import { useVisiblePolling } from './useVisiblePolling';

const POLL_MS = 60_000;
type Reply = { success?: boolean; data?: AssistantSnapshot; error?: string };

export function useAssistantPulse(enabled: boolean) {
  const [snapshot, setSnapshot] = useState<AssistantSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const signature = useRef('');

  // Repeated snapshots are common on the minute poll; identical content must not re-render the sidebar.
  const applySnapshot = useCallback((next: AssistantSnapshot | null) => {
    const json = next ? JSON.stringify(next) : '';
    if (json === signature.current) return;
    signature.current = json;
    setSnapshot(next);
  }, []);

  const load = useCallback(async (): Promise<AssistantSnapshot | null> => {
    try {
      const result = await window.api.invoke(ASSISTANT_CHANNELS.SNAPSHOT) as Reply;
      if (result?.success && result.data) { applySnapshot(result.data); return result.data; }
    } catch { /* 本地库未就绪时保持空态，下一次轮询会重试 */ }
    return null;
  }, [applySnapshot]);

  const run = useCallback(async (force = false): Promise<void> => {
    if (!enabled || busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try {
      const result = await window.api.invoke(ASSISTANT_CHANNELS.RUN, force) as Reply;
      if (result?.success && result.data) applySnapshot(result.data);
    } catch { /* 整理失败保留上一次结果 */ }
    finally { busyRef.current = false; setBusy(false); }
  }, [enabled, applySnapshot]);

  const dismiss = useCallback(async (reminder: AssistantReminder): Promise<void> => {
    try {
      const result = await window.api.invoke(ASSISTANT_CHANNELS.DISMISS, reminder.reminderId) as Reply;
      if (result?.success && result.data) applySnapshot(result.data);
    } catch { /* 忽略单条失败，下次整理会重新计算 */ }
  }, [applySnapshot]);

  const updateSettings = useCallback(async (patch: Partial<AssistantSettings>): Promise<void> => {
    try {
      const result = await window.api.invoke(ASSISTANT_CHANNELS.SETTINGS_UPDATE, patch) as Reply;
      if (result?.success && result.data) applySnapshot(result.data);
    } catch { /* 设置保存失败时保留旧值 */ }
  }, [applySnapshot]);

  useEffect(() => {
    if (!enabled) { applySnapshot(null); return; }
    void (async () => { const current = await load(); if (current?.due) await run(false); })();
  }, [enabled, load, run, applySnapshot]);

  useVisiblePolling(async () => {
    const current = await load();
    if (current?.due) await run(false);
  }, POLL_MS, enabled);

  useEffect(() => {
    if (!enabled) return;
    return window.api.on('assistant:updated', (next: unknown) => {
      if (next && typeof next === 'object' && 'reminders' in next) applySnapshot(next as AssistantSnapshot);
    });
  }, [enabled, applySnapshot]);

  return { snapshot, busy, run, dismiss, updateSettings };
}

type AssistantPulse = ReturnType<typeof useAssistantPulse>;
const PulseContext = createContext<AssistantPulse | null>(null);

/** One poller for the whole shell; pages and tabs read the same snapshot instead of running their own. */
export function AssistantPulseProvider({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
  const value = useAssistantPulse(enabled);
  return <PulseContext.Provider value={value}>{children}</PulseContext.Provider>;
}

export function useSharedAssistantPulse(): AssistantPulse | null {
  return useContext(PulseContext);
}
