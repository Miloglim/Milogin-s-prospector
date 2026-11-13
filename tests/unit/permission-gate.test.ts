import { describe, expect, it } from 'vitest';
import { isPermissionDenied } from '../../src/renderer/lib/permissionGate';

describe('renderer permission gate', () => {
  it('allows an explicit permission', () => {
    expect(isPermissionDenied(true)).toBe(false);
  });

  it('blocks only an explicit denial', () => {
    expect(isPermissionDenied(false)).toBe(true);
  });

  it('does not turn an unknown permission into a denial', () => {
    expect(isPermissionDenied(undefined)).toBe(false);
  });
});
