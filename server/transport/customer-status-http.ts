import { failure } from '../core/crm';
import { CUSTOMER_STATUS_ROUTES, CUSTOMER_STATUS_LIMITS } from '../core/customer-status';
import { LEAD_LIMITS } from '../core/leads';
import type { CustomerStatusService } from '../services/customer-status';
import { body, send, type BrowserHandler } from './http';

export function createCustomerStatusHandler(service: CustomerStatusService): BrowserHandler {
  return async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
    const prefix = `${CUSTOMER_STATUS_ROUTES.base}/`;
    if (!url.pathname.startsWith(prefix)) { send(response, failure('NOT_FOUND', '客户状态接口不存在')); return; }
    const parts = url.pathname.slice(prefix.length).split('/');
    const customerId = parts[0] ?? '';
    if (request.method === 'GET' && parts.length === 1) { send(response, await service.view(token, customerId)); return; }
    if (request.method !== 'POST' || parts.length !== 2 || !['correct', 'resume-ai'].includes(parts[1] ?? '')) { send(response, failure('NOT_FOUND', '客户状态接口不存在')); return; }
    const parsed = await body(request, LEAD_LIMITS.bodyBytes);
    if (!parsed.ok) { send(response, parsed); return; }
    if (!parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data) || 'customerId' in parsed.data && parsed.data.customerId !== customerId) { send(response, failure('INVALID_INPUT', '路径与客户编号不一致')); return; }
    const input = { ...parsed.data, customerId };
    send(response, parts[1] === 'correct' ? await service.correct(token, input) : await service.resumeAi(token, input));
  };
}
