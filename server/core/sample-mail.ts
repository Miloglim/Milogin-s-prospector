/** Temporary capability: authenticated account exports its own mail as a sample package. */

export const SAMPLE_MAIL_ROUTES = {
  packages: '/api/crm/sample-mail',
  upload: '/api/crm/sample-mail/upload',
} as const;

export const SAMPLE_MAIL_LIMITS = {
  packageBytes: 24 * 1024 * 1024,
  messageCount: 500,
  filename: 160,
  accountEmail: 320,
  note: 200,
  retention_days: 30,
  // The center keeps only the newest packages per account; older ones are removed on upload.
  max_packages_per_owner: 10,
} as const;

export interface SampleMailPackageMeta {
  packageId: string;
  accountEmail: string;
  filename: string;
  messageCount: number;
  bytes: number;
  sha256: string;
  rangeFrom: string | null;
  rangeTo: string | null;
  note: string;
  createdAt: string;
  expiresAt: string;
}

export interface SampleMailUpload {
  filename: string;
  accountEmail: string;
  messageCount: number;
  rangeFrom?: string | null;
  rangeTo?: string | null;
  note?: string;
  base64: string;
}

export function validSampleMailUpload(value: unknown): value is SampleMailUpload {
  if (!value || typeof value !== 'object') return false;
  const input = value as Record<string, unknown>;
  const text = (key: string, max: number) => typeof input[key] === 'string' && (input[key] as string).trim().length > 0 && (input[key] as string).length <= max;
  return text('filename', SAMPLE_MAIL_LIMITS.filename)
    && typeof input.accountEmail === 'string' && /^[^\s@]+@[^\s@]+$/.test(input.accountEmail) && input.accountEmail.length <= SAMPLE_MAIL_LIMITS.accountEmail
    && Number.isSafeInteger(input.messageCount) && (input.messageCount as number) > 0 && (input.messageCount as number) <= SAMPLE_MAIL_LIMITS.messageCount
    && (input.rangeFrom === undefined || input.rangeFrom === null || typeof input.rangeFrom === 'string' && input.rangeFrom.length <= 40)
    && (input.rangeTo === undefined || input.rangeTo === null || typeof input.rangeTo === 'string' && input.rangeTo.length <= 40)
    && (input.note === undefined || typeof input.note === 'string' && input.note.length <= SAMPLE_MAIL_LIMITS.note)
    && typeof input.base64 === 'string' && input.base64.length > 0
    && input.base64.length <= Math.ceil(SAMPLE_MAIL_LIMITS.packageBytes / 3) * 4 + 4;
}
