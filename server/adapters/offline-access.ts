import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { linkSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { OFFLINE_ACCESS_AUDIENCE, OFFLINE_ACCESS_LIMITS, type OfflineAccessIssuer, type OfflineAccessPayload } from '../core/offline-access';

export const OFFLINE_ACCESS_KEY_FILE = 'offline-access-private.pem';
const SECOND_MS = 1000;
const PRIVATE_KEY_BYTES = 4096;
const PRIVATE_FILE_MODE = 0o600;

/** The trusted center signs only a local profile lease; never bearer credentials. */
export function createOfflineAccessIssuer(privateKey: KeyObject, issuer: string): OfflineAccessIssuer {
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') throw new Error('离线签名密钥类型无效');
  const address = new URL(issuer);
  if (!['http:', 'https:'].includes(address.protocol) || address.origin !== issuer || address.username || address.password) throw new Error('离线签发中心地址无效');
  const publicKey = createPublicKey(privateKey).export({ format: 'pem', type: 'spki' }).toString();
  return {
    issue(identity, now, absoluteExpiresAt = Infinity) {
      if (identity.mustChangePassword) return undefined;
      if (!Number.isFinite(now)) throw new Error('离线授权时间无效');
      const expiresAt = Math.min(now + OFFLINE_ACCESS_LIMITS.validity_seconds * SECOND_MS, absoluteExpiresAt);
      if (!(expiresAt > now)) throw new Error('离线授权已到期');
      const payload: OfflineAccessPayload = { version: 1, audience: OFFLINE_ACCESS_AUDIENCE, issuer, issuedAt: new Date(now).toISOString(), expiresAt: new Date(expiresAt).toISOString(), identity };
      const serialized = JSON.stringify(payload);
      if (Buffer.byteLength(serialized, 'utf8') > OFFLINE_ACCESS_LIMITS.payload_bytes) throw new Error('离线授权身份超出限制');
      return { payload: serialized, signature: sign(null, Buffer.from(serialized, 'utf8'), privateKey).toString('base64url'), publicKey };
    },
  };
}

function readPrivateKey(path: string): KeyObject {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > PRIVATE_KEY_BYTES) throw new Error('离线签名密钥文件无效');
  const key = createPrivateKey(readFileSync(path));
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') throw new Error('离线签名密钥类型无效');
  return key;
}

/** Reuses the existing controlled runtime directory and inherited Windows ACL. */
export function loadOfflineAccessIssuer(runtimeDirectory: string, issuer: string): OfflineAccessIssuer {
  const directory = resolve(runtimeDirectory), info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('离线签名目录无效');
  const path = join(directory, OFFLINE_ACCESS_KEY_FILE);
  try { return createOfflineAccessIssuer(readPrivateKey(path), issuer); }
  catch (error) {
    // A missing file alone allows provisioning; corruption never regenerates trust.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('离线签名密钥读取失败');
  }
  const temporary = join(directory, `.offline-access-${randomUUID()}.tmp`);
  const generated = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' });
  writeFileSync(temporary, generated, { flag: 'wx', mode: PRIVATE_FILE_MODE });
  try {
    // An exclusive hard link publishes a complete file atomically. Racing nodes read the winner.
    try { linkSync(temporary, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('离线签名密钥保存失败'); }
  } finally { unlinkSync(temporary); }
  try { return createOfflineAccessIssuer(readPrivateKey(path), issuer); }
  catch { throw new Error('离线签名密钥读取失败'); } // Never expose private key or parser diagnostics.
}
