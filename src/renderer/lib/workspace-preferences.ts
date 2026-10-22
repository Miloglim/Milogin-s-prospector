export const WORKSPACE_DARK_STORAGE_KEY = 'prospector:workspace-dark';
export const WORKSPACE_DARK_CLASS = 'workspace-dark';
export const WORKSPACE_PREFERENCE_EVENT = 'prospector:workspace-preference-change';
const WORKSPACE_LIGHT_STORAGE_VALUE = '2:light';
const WORKSPACE_DARK_STORAGE_VALUE = '2:dark';

export function workspaceDarkEnabled(): boolean {
  try { return window.localStorage.getItem(WORKSPACE_DARK_STORAGE_KEY) === WORKSPACE_DARK_STORAGE_VALUE; }
  catch { return false; } // Storage failures fall back to the light workspace.
}

export function applyWorkspaceDark(enabled: boolean): void {
  document.body.classList.toggle(WORKSPACE_DARK_CLASS, enabled);
  try { window.localStorage.setItem(WORKSPACE_DARK_STORAGE_KEY, enabled ? WORKSPACE_DARK_STORAGE_VALUE : WORKSPACE_LIGHT_STORAGE_VALUE); }
  catch { /* Runtime preference remains applied even when persistence is unavailable. */ }
  window.dispatchEvent(new CustomEvent(WORKSPACE_PREFERENCE_EVENT, { detail: enabled }));
}

export function subscribeWorkspaceDark(listener: (enabled: boolean) => void): () => void {
  const handler = (event: Event) => listener(Boolean((event as CustomEvent<boolean>).detail));
  window.addEventListener(WORKSPACE_PREFERENCE_EVENT, handler);
  return () => window.removeEventListener(WORKSPACE_PREFERENCE_EVENT, handler);
}
