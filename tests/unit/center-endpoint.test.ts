import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ONLINE_LIMITS } from '../../src/shared/online-crm';
import { readConfiguredCenterBase, readConfiguredRatesBase } from '../../src/main/adapters/center-endpoint.adapter';

const roots: string[] = [];
function root() {
  const value = mkdtempSync(path.join(tmpdir(), 'prospector-center-'));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('configured center endpoint', () => {
  it('reads the packaged HTTPS endpoint and lets an explicit environment value override it', () => {
    const dir = root();
    writeFileSync(path.join(dir, 'center.json'), JSON.stringify({ baseUrl: 'https://crm.company.internal', ratesUrl: 'https://rates.company.internal' }));
    expect(readConfiguredCenterBase({}, dir)).toBe('https://crm.company.internal');
    expect(readConfiguredRatesBase(dir)).toBe('https://rates.company.internal');
    expect(readConfiguredCenterBase({ PROSPECTOR_CENTER_URL: 'https://crm.example.internal' }, dir))
      .toBe('https://crm.example.internal');
  });

  it('keeps the local test default only when no deployment endpoint is supplied', () => {
    expect(readConfiguredCenterBase({}, root())).toBe(ONLINE_LIMITS.defaultUrl);
    expect(readConfiguredRatesBase(root())).toBeNull();
  });

  it('rejects remote HTTP and malformed packaged values', () => {
    expect(() => readConfiguredCenterBase({ PROSPECTOR_CENTER_URL: 'http://crm.company.internal' }, root()))
      .toThrow('PROSPECTOR_CENTER_URL');
    const dir = root();
    writeFileSync(path.join(dir, 'center.json'), JSON.stringify({ baseUrl: 'https://crm.company.internal/api' }));
    expect(() => readConfiguredCenterBase({}, dir)).toThrow('center.json');
    writeFileSync(path.join(dir, 'center.json'), JSON.stringify({ baseUrl: 'https://crm.company.internal', ratesUrl: 'http://rates.company.internal' }));
    expect(() => readConfiguredRatesBase(dir)).toThrow('ratesUrl');
  });
});
