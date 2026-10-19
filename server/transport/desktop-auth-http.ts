import type { BrowserHandler } from './http';
import { body, send } from './http';
import { DESKTOP_AUTH_ROUTES } from '../core/desktop-session';
import { failure } from '../core/crm';
import type { LoginGate, OnlineConfig } from '../core/auth';
import type { DesktopSessionService } from '../services/desktop-session';

export function createDesktopAuthHandler(service: DesktopSessionService, gate: LoginGate, config: OnlineConfig): BrowserHandler {
  return async (request, response) => {
    const path = request.url ?? '', token = /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
    if (request.method === 'GET' && path === DESKTOP_AUTH_ROUTES.me) { send(response, await service.me(token)); return; }
    if (request.method !== 'POST') { send(response, failure('NOT_FOUND', '接口不存在')); return; }
    const input = await body(request, config.request_body_bytes);
    if (!input.ok) { send(response, input); return; }
    if (path === DESKTOP_AUTH_ROUTES.register) {
      const email = input.data && typeof input.data === 'object' && 'email' in input.data && typeof input.data.email === 'string' ? input.data.email.trim().toLowerCase() : 'invalid';
      send(response, gate.allow(`register:${email}`, request.socket.remoteAddress ?? 'unknown') ? await service.register(input.data) : failure('RATE_LIMITED', '请求过多，请稍后重试')); return;
    }
    if (path === DESKTOP_AUTH_ROUTES.login) {
      const email = input.data && typeof input.data === 'object' && 'email' in input.data && typeof input.data.email === 'string' ? input.data.email.trim().toLowerCase() : 'invalid';
      send(response, gate.allow(email, request.socket.remoteAddress ?? 'unknown') ? await service.login(input.data) : failure('RATE_LIMITED', '登录尝试过多，请稍后重试')); return;
    }
    if (path === DESKTOP_AUTH_ROUTES.refresh) send(response, await service.refresh(input.data));
    else if (path === DESKTOP_AUTH_ROUTES.logout) send(response, await service.logout(input.data));
    else if (path === DESKTOP_AUTH_ROUTES.password) send(response, await service.changePassword(token, input.data));
    else send(response, failure('NOT_FOUND', '接口不存在'));
  };
}
