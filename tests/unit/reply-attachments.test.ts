import { describe, expect, it } from 'vitest';
import { replyAttachments } from '../../src/main/core/reply-attachments';

describe('reply attachment validation', () => {
  it('decodes files and strips path separators from names', () => {
    const result = replyAttachments([{ filename: '../报价.xlsx', contentType: 'application/vnd.ms-excel', dataBase64: Buffer.from('hello').toString('base64') }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]).toMatchObject({ filename: '_报价.xlsx', contentType: 'application/vnd.ms-excel' });
    expect(result.data[0]!.content.toString()).toBe('hello');
  });

  it('rejects too many files, oversized totals and malformed base64', () => {
    expect(replyAttachments(Array.from({ length: 11 }, () => ({ filename: 'a.txt', dataBase64: 'YQ==' })))).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(replyAttachments([{ filename: 'big.bin', dataBase64: Buffer.alloc(26 * 1024 * 1024).toString('base64') }])).toMatchObject({ ok: false, error: { code: 'PAYLOAD_TOO_LARGE' } });
    expect(replyAttachments([{ filename: 'bad.txt', dataBase64: 'not base64' }])).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });
});
