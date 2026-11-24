import { describe, expect, it } from 'vitest';
import { parseWindowsEnvironmentValue } from '../../server/adapters/environment-secret';

describe('windows environment secret fallback', () => {
  it('parses a REG_SZ value without requiring a particular locale', () => {
    const output = [
      '',
      'HKEY_CURRENT_USER\\Environment',
      '    PROVIDER_KEY_TEST    REG_SZ    synthetic-value',
      '',
    ].join('\r\n');
    expect(parseWindowsEnvironmentValue(output, 'PROVIDER_KEY_TEST')).toBe('synthetic-value');
  });

  it('ignores other names and empty output', () => {
    expect(parseWindowsEnvironmentValue('    OTHER    REG_SZ    nope', 'PROVIDER_KEY_TEST')).toBe('');
    expect(parseWindowsEnvironmentValue('', 'PROVIDER_KEY_TEST')).toBe('');
  });
});
