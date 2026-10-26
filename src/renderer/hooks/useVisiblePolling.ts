import { useEffect, useRef } from 'react';

/** Runs one poll after the previous attempt settles and pauses while the Electron page is hidden. */
export function useVisiblePolling(callback: () => void | Promise<void>, intervalMs: number, enabled = true): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let running = false;
    const run = () => {
      if (cancelled || running || document.visibilityState === 'hidden') return;
      running = true;
      void Promise.resolve(callbackRef.current())
        .catch(() => { /* Callers surface request failures in their own UI; one failed poll must not stop later refreshes. */ })
        .finally(() => { running = false; });
    };
    const visibilityChanged = () => {
      if (document.visibilityState !== 'hidden' && !running) run();
    };
    document.addEventListener('visibilitychange', visibilityChanged);
    const timer = setInterval(run, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [enabled, intervalMs]);
}
