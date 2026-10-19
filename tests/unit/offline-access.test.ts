import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOfflineAccessIssuer, loadOfflineAccessIssuer, OFFLINE_ACCESS_KEY_FILE } from '../../server/adapters/offline-access';
import { OFFLINE_ACCESS_AUDIENCE, OFFLINE_ACCESS_LIMITS } from '../../server/core/offline-access';
import type { Identity } from '../../server/core/auth';
import { createDesktopSessionService } from '../../server/services/desktop-session';
import { success } from '../../server/core/crm';

const NOW = Date.parse('2026-10-12T12:00:00.000Z');
const SECOND_MS = 1000;
const identity: Identity = { userId: 'synthetic-user', displayName: 'Synthetic', email: 'synthetic@example.invalid', emailVerified: false, identityAdmin: false, crmRoles: ['sales'] };
const issuer = 'http://127.0.0.1:55844';
const folders: string[] = [];
const race = vi.hoisted(() => ({ winner: undefined as string | undefined }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, linkSync: (source: string, destination: string) => {
    if (race.winner) {
      actual.writeFileSync(destination, race.winner, { flag: 'wx' });
      throw Object.assign(new Error('Synthetic competing startup'), { code: 'EEXIST' });
    }
    return actual.linkSync(source, destination);
  } };
});
afterEach(() => { race.winner = undefined; for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
function directory() { const folder = mkdtempSync(join(tmpdir(), 'prospector-offline-test-')); folders.push(folder); return folder; }
function signingIssuer() { return createOfflineAccessIssuer(generateKeyPairSync('ed25519').privateKey, issuer); }

describe('center signed local-only access', () => {
  it('caps offline access at the fixed credential deadline and rejects an expired deadline', () => {
    const signer=signingIssuer(),deadline=NOW+SECOND_MS;
    expect(JSON.parse(signer.issue(identity,NOW,deadline)!.payload).expiresAt).toBe(new Date(deadline).toISOString());
    expect(()=>signer.issue(identity,NOW,NOW)).toThrow();
  });
  it('signs the exact JSON identity, audience and 72 hour bound with SPKI public key', () => {
    const grant = signingIssuer().issue(identity, NOW)!;
    expect(grant.publicKey).toContain('BEGIN PUBLIC KEY');
    expect(verify(null, Buffer.from(grant.payload), grant.publicKey, Buffer.from(grant.signature, 'base64url'))).toBe(true);
    const payload = JSON.parse(grant.payload);
    expect(payload).toMatchObject({ version: 1, audience: OFFLINE_ACCESS_AUDIENCE, issuer, identity });
    expect(Date.parse(payload.expiresAt) - Date.parse(payload.issuedAt)).toBe(OFFLINE_ACCESS_LIMITS.validity_seconds * SECOND_MS);
    expect(verify(null, Buffer.from(grant.payload.replace('synthetic-user', 'different-user')), grant.publicKey, Buffer.from(grant.signature, 'base64url'))).toBe(false);
    expect(grant.payload).not.toContain('refreshToken');
  });
  it('refuses restricted identities, oversized snapshots and non-finite time', () => {
    const signer = signingIssuer();
    expect(signer.issue({ ...identity, mustChangePassword: true }, NOW)).toBeUndefined();
    expect(() => signer.issue({ ...identity, displayName: 'x'.repeat(OFFLINE_ACCESS_LIMITS.payload_bytes) }, NOW)).toThrow();
    expect(() => signer.issue(identity, NaN)).toThrow();
  });
  it('persists one key and verifies prior grants after a runtime restart', () => {
    const folder = directory();
    const grant = loadOfflineAccessIssuer(folder, issuer).issue(identity, NOW)!;
    const file = readFileSync(join(folder, OFFLINE_ACCESS_KEY_FILE), 'utf8');
    expect(file).toContain('BEGIN PRIVATE KEY');
    const restarted = loadOfflineAccessIssuer(folder, issuer).issue(identity, NOW + SECOND_MS)!;
    expect(restarted.publicKey).toBe(grant.publicKey);
    expect(verify(null, Buffer.from(grant.payload), restarted.publicKey, Buffer.from(grant.signature, 'base64url'))).toBe(true);
  });
  it('fails closed for corrupt or wrong-algorithm stored keys without replacing them', () => {
    const folder = directory(), keyPath = join(folder, OFFLINE_ACCESS_KEY_FILE);
    for (const key of ['corrupt-key', generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()]) {
      writeFileSync(keyPath, key);
      expect(() => loadOfflineAccessIssuer(folder, issuer)).toThrow();
      expect(readFileSync(keyPath, 'utf8')).toBe(key);
    }
  });
  it('uses a competing startup winner without replacing its complete key file', () => {
    const folder = directory();
    race.winner = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const expected = race.winner;
    const grant = loadOfflineAccessIssuer(folder, issuer).issue(identity, NOW)!;
    expect(readFileSync(join(folder, OFFLINE_ACCESS_KEY_FILE), 'utf8')).toBe(expected);
    expect(verify(null, Buffer.from(grant.payload), grant.publicKey, Buffer.from(grant.signature, 'base64url'))).toBe(true);
  });
  it('rejects a linked runtime directory rather than provisioning outside it', () => {
    const folder = directory(), linked = join(directory(), 'linked-runtime');
    symlinkSync(folder, linked, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => loadOfflineAccessIssuer(linked, issuer)).toThrow();
  });
  it('adds grants to login and renewal but keeps restricted and legacy services compatible', async () => {
    let current = identity;
    const repo: any = { credential: async () => success({ userId: identity.userId, passwordHash: 'synthetic', active: true, securityRevision: 1 }), createDesktopSession: async () => success(current), rotateDesktopSession: async () => success({ identity: current, expiresAt: new Date(NOW + SECOND_MS).toISOString() }) };
    const passwords = { verify: async () => true, hash: async () => 'synthetic' };
    const tokens = { create: () => 'a'.repeat(43), hash: (token: string) => token };
    const service = createDesktopSessionService(repo, passwords, tokens, { now: () => NOW }, 3600, signingIssuer());
    for (const result of [await service.login({ email: identity.email, password: 'synthetic-password' }), await service.refresh({ refreshToken: tokens.create() })]) {
      expect(result.ok).toBe(true);
      if (result.ok) expect(JSON.parse(result.data.offlineAccess!.payload).identity).toEqual(identity);
    }
    current = { ...identity, mustChangePassword: true };
    const restricted = await service.login({ email: identity.email, password: 'synthetic-password' });
    expect(restricted.ok && restricted.data.offlineAccess).toBeUndefined();
    const legacy = await createDesktopSessionService(repo, passwords, tokens, { now: () => NOW }, 3600).refresh({ refreshToken: tokens.create() });
    expect(legacy.ok && legacy.data.offlineAccess).toBeUndefined();
  });
});
