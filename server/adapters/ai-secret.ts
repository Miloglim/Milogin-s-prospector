import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const KEY_FILE = 'ai-model-keys.key';
const VERSION = 'v1';
let cachedKey: Buffer | null = null;

function runtimeDir(): string {
  return process.env.PROSPECTOR_CENTER_RUNTIME_DIR
    || (process.env.ProgramData ? path.join(process.env.ProgramData, 'MiloginCenter') : path.join(process.cwd(), '.runtime'));
}

function masterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const configured = process.env.CENTER_AI_ENCRYPTION_KEY?.trim();
  if (configured) {
    const value = Buffer.from(configured, 'base64');
    if (value.length !== 32) throw new Error('CENTER_AI_ENCRYPTION_KEY 必须是 32 字节 base64');
    cachedKey = value;
    return cachedKey;
  }
  const file = path.join(runtimeDir(), KEY_FILE);
  if (existsSync(file)) {
    const value = readFileSync(file);
    if (value.length !== 32) throw new Error('AI 密钥加密文件无效');
    cachedKey = value;
    return cachedKey;
  }
  mkdirSync(runtimeDir(), { recursive: true });
  const value = randomBytes(32);
  writeFileSync(file, value, { mode: 0o600 });
  cachedKey = value;
  return cachedKey;
}

export function encryptAiSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptAiSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  const [version, iv, tag, encrypted] = value.split('.');
  if (version !== VERSION || !iv || !tag || !encrypted) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    // 密钥损坏或主密钥变化时按未配置处理，调用方会回退环境变量。
    return null;
  }
}