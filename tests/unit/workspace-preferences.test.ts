// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { WORKSPACE_DARK_CLASS, WORKSPACE_DARK_STORAGE_KEY, applyWorkspaceDark, workspaceDarkEnabled } from '../../src/renderer/lib/workspace-preferences';

describe('workspace appearance preference', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.body.className = '';
  });

  it('defaults to the light workspace', () => {
    expect(workspaceDarkEnabled()).toBe(false);
  });

  it('treats pre-versioned automatic dark values as light once', () => {
    window.localStorage.setItem(WORKSPACE_DARK_STORAGE_KEY, '1');
    expect(workspaceDarkEnabled()).toBe(false);
    applyWorkspaceDark(workspaceDarkEnabled());
    expect(window.localStorage.getItem(WORKSPACE_DARK_STORAGE_KEY)).toBe('2:light');
  });

  it('applies and persists both workspace tones', () => {
    applyWorkspaceDark(false);
    expect(document.body.classList.contains(WORKSPACE_DARK_CLASS)).toBe(false);
    expect(window.localStorage.getItem(WORKSPACE_DARK_STORAGE_KEY)).toBe('2:light');
    expect(workspaceDarkEnabled()).toBe(false);

    applyWorkspaceDark(true);
    expect(document.body.classList.contains(WORKSPACE_DARK_CLASS)).toBe(true);
    expect(window.localStorage.getItem(WORKSPACE_DARK_STORAGE_KEY)).toBe('2:dark');
    expect(workspaceDarkEnabled()).toBe(true);
  });
});
