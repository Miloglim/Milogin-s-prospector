import { CONTACT_CHANGE_ROUTE } from '../core/contact-change-feed';
import { send, type BrowserHandler } from './http';
import type { ContactChangeService } from '../services/contact-change-feed';
import { failure } from '../core/crm';
export function createContactChangeHandler(service: ContactChangeService): BrowserHandler { return async (request, response) => { const path = new URL(request.url ?? '/', 'http://localhost').pathname; if (request.method !== 'GET' || path !== CONTACT_CHANGE_ROUTE) { send(response, failure('NOT_FOUND', '联系人变化接口不存在')); return; } const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '')?.[1] ?? ''; const url = new URL(request.url ?? '/', 'http://localhost'); send(response, await service.feed(token, { after: url.searchParams.get('after') ?? '0', limit: Number(url.searchParams.get('limit') ?? 50) })); }; }
