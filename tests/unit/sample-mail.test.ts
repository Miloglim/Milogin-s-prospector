import { describe, expect, it } from 'vitest';
import { SAMPLE_MAIL_LIMITS, validSampleMailUpload } from '../../server/core/sample-mail';

const base = { filename: 'sample.json', accountEmail: 'daisy@example.invalid', messageCount: 2, base64: 'eyJ2IjoxfQ==' };

describe('sample mail upload contract', () => {
  it('accepts a bounded package', () => {
    expect(validSampleMailUpload(base)).toBe(true);
    expect(validSampleMailUpload({ ...base, note: '询盘样本', rangeFrom: '2026-11-01T00:00:00.000Z' })).toBe(true);
  });
  it('rejects invalid accounts, counts and payloads', () => {
    expect(validSampleMailUpload({ ...base, accountEmail: 'not-an-email' })).toBe(false);
    expect(validSampleMailUpload({ ...base, messageCount: 0 })).toBe(false);
    expect(validSampleMailUpload({ ...base, messageCount: SAMPLE_MAIL_LIMITS.messageCount + 1 })).toBe(false);
    expect(validSampleMailUpload({ ...base, base64: '' })).toBe(false);
    expect(validSampleMailUpload({ ...base, filename: ' '.repeat(3) })).toBe(false);
    expect(validSampleMailUpload(null)).toBe(false);
  });
});
