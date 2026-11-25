import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decryptAiSecret, encryptAiSecret } from '../../server/adapters/ai-secret';

describe('AI model secret storage', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ai-secret-'));
    process.env.PROSPECTOR_CENTER_RUNTIME_DIR = dir;
    delete process.env.CENTER_AI_ENCRYPTION_KEY;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.PROSPECTOR_CENTER_RUNTIME_DIR;
  });

  it('encrypts and decrypts without storing plaintext', () => {
    const encrypted = encryptAiSecret('sk-test-value');
    expect(encrypted).not.toContain('sk-test-value');
    expect(encrypted.startsWith('v1.')).toBe(true);
    expect(decryptAiSecret(encrypted)).toBe('sk-test-value');
  });

  it('returns null for a damaged secret', () => {
    expect(decryptAiSecret('v1.bad.bad.bad')).toBeNull();
    expect(decryptAiSecret(null)).toBeNull();
  });
});