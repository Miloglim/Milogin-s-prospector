import { failure } from '../core/crm';
import { LEAD_INGRESS_ROUTES } from '../core/lead-ingress';
import { LEAD_LIMITS } from '../core/leads';
import type { LeadService } from '../services/leads';
import { body, send, type BrowserHandler } from './http';

export function createLeadIngressHandler(service: LeadService): BrowserHandler {
  return async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
    if (request.method === 'GET' && url.pathname === LEAD_INGRESS_ROUTES.decision) {
      if ([...url.searchParams.keys()].some(key => !['source','idempotencyKey'].includes(key))
        || url.searchParams.getAll('source').length !== 1 || url.searchParams.getAll('idempotencyKey').length !== 1) {
        send(response, failure('INVALID_INPUT', '冲突记录参数无效'));
        return;
      }
      send(response, await service.leadIngressDecision(token, {
        source: url.searchParams.get('source'),
        idempotencyKey: url.searchParams.get('idempotencyKey'),
      }));
      return;
    }
    if (request.method === 'POST' && url.pathname === LEAD_INGRESS_ROUTES.resolve) {
      const parsed = await body(request, LEAD_LIMITS.bodyBytes);
      send(response, parsed.ok ? await service.resolveLeadIngress(token, parsed.data) : parsed);
      return;
    }
    send(response, failure('NOT_FOUND', '线索冲突接口不存在'));
  };
}
