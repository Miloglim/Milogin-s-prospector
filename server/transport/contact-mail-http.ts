import { failure } from '../core/crm';
import { CONTACT_MAIL_ROUTE, CONTACT_MAIL_LIMITS } from '../core/contact-mail';
import type { ContactMailService } from '../services/contact-mail';
import { body, send, type BrowserHandler } from './http';
export function createContactMailHandler(service: ContactMailService): BrowserHandler {
  return async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method !== 'POST' || url.pathname !== CONTACT_MAIL_ROUTE) { send(response, failure('NOT_FOUND', '邮件事件接口不存在')); return; }
    if (url.search) { send(response, failure('INVALID_INPUT', '邮件事件不接受查询参数')); return; }
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
    if (!token) { send(response, failure('UNAUTHORIZED', '会话无效')); return; }
    const parsed = await body(request, CONTACT_MAIL_LIMITS.bodyBytes);
    send(response, parsed.ok ? await service.record(token, parsed.data) : parsed);
  };
}
