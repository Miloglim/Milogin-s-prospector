export const WORKSPACE_DARK_STORAGE_KEY = 'prospector:workspace-dark';
export const WORKSPACE_DARK_CLASS = 'workspace-dark';
export const WORKSPACE_PREFERENCE_EVENT = 'prospector:workspace-preference-change';

export function workspaceDarkEnabled(): boolean {
  try { return window.localStorage.getItem(WORKSPACE_DARK_STORAGE_KEY) !== '0'; }
  catch { return true; } // Storage failures fall back to the default gray workspace.
}

export function applyWorkspaceDark(enabled: boolean): void {
  document.body.classList.toggle(WORKSPACE_DARK_CLASS, enabled);
  try { window.localStorage.setItem(WORKSPACE_DARK_STORAGE_KEY, enabled ? '1' : '0'); }
  catch { /* Runtime preference remains applied even when persistence is unavailable. */ }
  window.dispatchEvent(new CustomEvent(WORKSPACE_PREFERENCE_EVENT, { detail: enabled }));
}

export function subscribeWorkspaceDark(listener: (enabled: boolean) => void): () => void {
  const handler = (event: Event) => listener(Boolean((event as CustomEvent<boolean>).detail));
  window.addEventListener(WORKSPACE_PREFERENCE_EVENT, handler);
  return () => window.removeEventListener(WORKSPACE_PREFERENCE_EVENT, handler);
}
