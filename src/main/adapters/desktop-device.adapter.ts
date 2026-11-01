import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { DesktopDeviceContext } from '../../../server/core/desktop-session';

const DEVICE_FILE = 'prospector-device.json';
const DEVICE_FILE_VERSION = 1;
const DEVICE_NAME_MAX = 120;

interface StoredDevice { version: number; deviceId: string }

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value);
}

/** Stable installation identity; it contains no account or credential data. */
export function loadDesktopDeviceContext(userData: string, appVersion: string): DesktopDeviceContext {
  const file = join(userData, DEVICE_FILE);
  let deviceId = '';
  if (existsSync(file)) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as StoredDevice;
      if (saved.version === DEVICE_FILE_VERSION && validId(saved.deviceId)) deviceId = saved.deviceId;
    } catch { /* Invalid device metadata is replaced with a new local identity. */ }
  }
  if (!deviceId) {
    deviceId = randomUUID();
    mkdirSync(userData, { recursive: true });
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: DEVICE_FILE_VERSION, deviceId }), { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, file);
  }
  return {
    product: 'crm',
    deviceId,
    deviceName: (hostname() || 'Prospector').slice(0, DEVICE_NAME_MAX),
    platform: process.platform,
    appVersion,
  };
}
