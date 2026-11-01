import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDesktopDeviceContext } from '../../src/main/adapters/desktop-device.adapter';

const roots: string[] = [];
const root = () => {
  const value = mkdtempSync(join(tmpdir(), 'prospector-device-'));
  roots.push(value);
  return value;
};

afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }); });

describe('desktop device identity', () => {
  it('keeps the installation id across launches without storing account data', () => {
    const directory = root();
    const first = loadDesktopDeviceContext(directory, '0.67.0');
    const restarted = loadDesktopDeviceContext(directory, '0.67.1');
    expect(restarted.deviceId).toBe(first.deviceId);
    expect(restarted).toMatchObject({ product: 'crm', platform: process.platform, appVersion: '0.67.1' });
    const saved = readFileSync(join(directory, 'prospector-device.json'), 'utf8');
    expect(saved).toContain(first.deviceId);
    expect(saved).not.toMatch(/email|password|token|userId/i);
  });
});
