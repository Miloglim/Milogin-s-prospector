// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { readImportFile } from '../../src/renderer/components/ImportDrawer';

const LEGACY_FILE_LIMIT = 10 * 1024 * 1024;

describe('original drawer file contents', () => {
  it('reads uploads above the retired 10 MiB threshold', async () => {
    const read = vi.fn(async () => new ArrayBuffer(0));
    await expect(readImportFile({ name: 'large.xlsx', size: LEGACY_FILE_LIMIT + 1, arrayBuffer: read } as unknown as File, true)).resolves.toMatchObject({ type: 'xlsx', data: '' });
    expect(read).toHaveBeenCalledOnce();
  });
  it('preserves exact GB18030 CSV bytes for main-process decoding', async () => {
    const bytes = new Uint8Array([0xb9, 0xab, 0xcb, 0xbe, 0x2c, 0xd3, 0xca, 0xcf, 0xe4]);
    const file = { name: 'legacy.csv', size: bytes.length, arrayBuffer: async () => bytes.buffer } as File;
    const result = await readImportFile(file, true);
    expect(result).toMatchObject({ type: 'csv', encoding: 'base64' });
    expect(Array.from(atob(result.data), value => value.charCodeAt(0))).toEqual(Array.from(bytes));
  });
  it('rejects unsupported upload types', async () => {
    const file = { name: 'boundary.xlsx', size: LEGACY_FILE_LIMIT + 1, arrayBuffer: async () => new ArrayBuffer(0) } as File;
    await expect(readImportFile({ ...file, name: 'other.bin' } as File, true)).rejects.toThrow('CSV');
  });
});
