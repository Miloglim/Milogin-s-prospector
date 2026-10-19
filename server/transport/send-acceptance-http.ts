import { failure } from '../core/crm';
import { SEND_ACCEPTANCE_ROUTES, SEND_AUTHORIZATION_LIMITS } from '../core/send-acceptance';
import type { SendAcceptanceService } from '../services/send-acceptance';
import { body, send, type BrowserHandler } from './http';

export function createSendAcceptanceHandler(service: SendAcceptanceService): BrowserHandler {
  return async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method !== 'POST' || !Object.values(SEND_ACCEPTANCE_ROUTES).some(route => route === url.pathname)) {
      send(response, failure('NOT_FOUND', '发送归档接口不存在')); return;
    }
    if (url.search) { send(response, failure('INVALID_INPUT', '发送归档不接受查询参数')); return; }
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
    if (!token) { send(response, failure('UNAUTHORIZED', '会话无效')); return; }
    const parsed = await body(request, SEND_AUTHORIZATION_LIMITS.bodyBytes);
    if (!parsed.ok) { send(response, parsed); return; }
    send(response, await (url.pathname === SEND_ACCEPTANCE_ROUTES.authorize
      ? service.authorize(token, parsed.data) : service.accept(token, parsed.data)));
  };
}
