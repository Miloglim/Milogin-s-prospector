import { failure } from '../core/crm';
import { SAMPLE_MAIL_LIMITS, SAMPLE_MAIL_ROUTES } from '../core/sample-mail';
import type { SampleMailService } from '../services/sample-mail';
import { body, send, type BrowserHandler } from './http';

const JSON_LIMIT = Math.ceil(SAMPLE_MAIL_LIMITS.packageBytes / 3) * 4 + 64 * 1024;

export function createSampleMailHandler(service: SampleMailService): BrowserHandler {
  return async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
    if (request.method === 'GET' && url.pathname === SAMPLE_MAIL_ROUTES.packages) {
      send(response, await service.list(token));
      return;
    }
    if (request.method === 'POST' && url.pathname === SAMPLE_MAIL_ROUTES.upload) {
      const parsed = await body(request, JSON_LIMIT);
      if (!parsed.ok) { send(response, parsed); return; }
      send(response, await service.upload(token, parsed.data));
      return;
    }
    const file = /^\/api\/crm\/sample-mail\/([^/]+)\/file$/.exec(url.pathname);
    if (request.method === 'GET' && file) {
      const result = await service.read(token, file[1]!);
      if (!result.ok) { send(response, result); return; }
      send(response, { ok: true, data: { meta: result.data.meta, base64: Buffer.from(result.data.data).toString('base64') } });
      return;
    }
    const item = /^\/api\/crm\/sample-mail\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'DELETE' && item) {
      send(response, await service.remove(token, item[1]!));
      return;
    }
    send(response, failure('NOT_FOUND', '样例邮件接口不存在'));
  };
}
