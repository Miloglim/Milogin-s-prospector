import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = vi.hoisted(() => ({ path: '' }));
vi.mock('../../src/main/logger', () => ({ Log: { info: vi.fn(), warn: vi.fn() } }));
vi.mock('../../src/main/services/sample-mail.service', () => ({
  autoSampleMailBatch: vi.fn(),
  buildPackageFromRows: vi.fn(),
}));

import { autoSampleMailBatch, buildPackageFromRows } from '../../src/main/services/sample-mail.service';
import { startSampleMailAutoSync } from '../../src/main/services/sample-mail-sync.service';

describe('one-shot sample mail sync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    dir.path = mkdtempSync(join(tmpdir(), 'sample-sync-'));
    (globalThis as Record<string, unknown>).__PROSPECTOR_SAMPLE_MAIL__ = true;
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir.path, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('uploads 1000 messages in ten batches and then stops for good', async () => {
    let batch = 0;
    (autoSampleMailBatch as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      batch += 1;
      if (batch > 10) return null;
      return { accountEmail: 'daisy@example.invalid', rows: Array.from({ length: 100 }, (_, i) => ({ id: batch * 1000 + i })) };
    });
    (buildPackageFromRows as unknown as ReturnType<typeof vi.fn>).mockImplementation((_email: string, rows: Array<{ id: number }>) => ({
      accountEmail: 'daisy@example.invalid', filename: 'auto.json', count: rows.length, bytes: 10, base64: 'e30=',
      messageIds: rows.map(row => row.id),
    }));
    const upload = vi.fn(async () => ({ ok: true, data: { packageId: 'p' } }));
    startSampleMailAutoSync({ currentIdentity: () => ({ userId: 'u', baseUrl: 'http://x' }), isOnline: () => true, sampleMailUpload: upload } as never, join(dir.path, 'sample-mail-sync.json'));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(upload).toHaveBeenCalledTimes(10);
    const state = JSON.parse(readFileSync(join(dir.path, 'sample-mail-sync.json'), 'utf8')) as { done: boolean; uploadedIds: number[] };
    expect(state.done).toBe(true);
    expect(state.uploadedIds).toHaveLength(1000);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(upload).toHaveBeenCalledTimes(10);
  });
});
