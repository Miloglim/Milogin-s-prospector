// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { readImportFile } from '../../src/renderer/components/ImportDrawer';
import { ONLINE_LIMITS } from '../../src/shared/online-crm';

describe('original drawer file contents', () => {
  it('rejects oversized raw uploads before reading or base64 expansion', async () => {
    const read = vi.fn();
    await expect(readImportFile({ name: 'oversized.xlsx', size: ONLINE_LIMITS.fileBytes + 1, arrayBuffer: read } as unknown as File, true)).rejects.toThrow('10 MiB');
    expect(read).not.toHaveBeenCalled();
  });
  it('preserves exact GB18030 CSV bytes for main-process decoding', async () => {
    const bytes = new Uint8Array([0xb9, 0xab, 0xcb, 0xbe, 0x2c, 0xd3, 0xca, 0xcf, 0xe4]);
    const file = { name: 'legacy.csv', size: bytes.length, arrayBuffer: async () => bytes.buffer } as File;
    const result = await readImportFile(file, true);
    expect(result).toMatchObject({ type: 'csv', encoding: 'base64' });
    expect(Array.from(atob(result.data), value => value.charCodeAt(0))).toEqual(Array.from(bytes));
  });
  it('accepts the exact file limit and rejects unsupported upload types', async () => {
    const file = { name: 'boundary.xlsx', size: ONLINE_LIMITS.fileBytes, arrayBuffer: async () => new ArrayBuffer(0) } as File;
    await expect(readImportFile(file, true)).resolves.toMatchObject({ type: 'xlsx', data: '' });
    await expect(readImportFile({ ...file, name: 'other.bin' } as File, true)).rejects.toThrow('CSV');
  });
});
