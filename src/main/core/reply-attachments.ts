import { failure, success, type Result } from '../../../server/core/crm';

export interface ReplyAttachment {
  filename: string;
  contentType?: string;
  content: Buffer;
}

const MAX_FILES = 10;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const MAX_FILENAME = 200;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Validate renderer-supplied reply attachments before they reach SMTP. */
export function replyAttachments(value: unknown): Result<ReplyAttachment[]> {
  if (value === undefined || value === null) return success([]);
  if (!Array.isArray(value) || value.length > MAX_FILES) return failure('INVALID_INPUT', `附件最多 ${MAX_FILES} 个`);
  const result: ReplyAttachment[] = [];
  let total = 0;
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return failure('INVALID_INPUT', '附件参数无效');
    const row = item as Record<string, unknown>;
    const filename = typeof row.filename === 'string' ? row.filename.trim().replace(/[\\/]/g, '_').replace(/^\.+/, '').slice(0, MAX_FILENAME) : '';
    const data = typeof row.dataBase64 === 'string' ? row.dataBase64 : '';
    if (!filename || !data || data.length % 4 !== 0 || !BASE64.test(data)) return failure('INVALID_INPUT', '附件内容无效');
    const content = Buffer.from(data, 'base64');
    if (!content.length) return failure('INVALID_INPUT', '附件内容为空');
    total += content.length;
    if (total > MAX_TOTAL_BYTES) return failure('PAYLOAD_TOO_LARGE', '附件总大小超过 25MB');
    const contentType = typeof row.contentType === 'string' && row.contentType.trim() ? row.contentType.trim().slice(0, 120) : undefined;
    result.push({ filename, content, ...(contentType ? { contentType } : {}) });
  }
  return success(result);
}
