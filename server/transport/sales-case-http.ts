import type { SalesCaseService } from '../services/sales-cases';
import { failure, success } from '../core/crm';
import { body, send, type BrowserHandler } from './http';

const ROUTE = '/api/crm/sales-cases';
const TOKEN = /^Bearer ([A-Za-z0-9_-]{43})$/;

export function createSalesCaseHandler(service: SalesCaseService): BrowserHandler {
  return async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith(ROUTE)) { send(response, failure('NOT_FOUND', '销售 Case 接口不存在')); return; }
    const token = TOKEN.exec(request.headers.authorization ?? '')?.[1] ?? '';
    if (!token) { send(response, failure('UNAUTHORIZED', '请先登录中心账号')); return; }
    if (request.method === 'GET' && url.pathname === ROUTE) {
      const limit = Number(url.searchParams.get('limit') ?? 25);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      send(response, await service.list(token, { limit, offset }));
      return;
    }
    if (request.method === 'POST' && url.pathname === `${ROUTE}/ensure`) {
      const input = await body(request, 64 * 1024);
      if (!input.ok) { send(response, input); return; }
      const value = input.data && typeof input.data === 'object' && !Array.isArray(input.data) ? input.data as Record<string, unknown> : {};
      const contactId = Number(value.contactId);
      const customerId = typeof value.customerId === 'string' ? value.customerId : '';
      const source = typeof value.source === 'string' ? value.source : 'inquiry';
      send(response, await service.ensure(token, contactId, customerId, source));
      return;
    }
    const parts = url.pathname.slice(ROUTE.length + 1).split('/').filter(Boolean);
    if (request.method === 'GET' && parts.length === 1) { send(response, await service.detail(token, parts[0]!)); return; }
    if (request.method === 'POST' && parts.length === 2 && parts[1] === 'transition') {
      const input = await body(request, 256 * 1024);
      if (!input.ok) { send(response, input); return; }
      send(response, await service.transition(token, parts[0]!, input.data));
      return;
    }
    if (request.method === 'GET' && parts.length === 2 && parts[1] === 'overview') { send(response, await service.detailWithProposals(token, parts[0]!)); return; }
    if (request.method === 'GET' && parts.length === 2 && parts[1] === 'proposals') {
      send(response, await service.listProposals(token, parts[0]!, url.searchParams.get('status') ?? undefined));
      return;
    }
    if (request.method === 'POST' && parts.length === 2 && parts[1] === 'proposals') {
      const input = await body(request, 1024 * 1024);
      if (!input.ok) { send(response, input); return; }
      send(response, await service.createProposal(token, parts[0]!, input.data));
      return;
    }
    if (request.method === 'GET' && parts.length === 3 && parts[1] === 'proposals') {
      send(response, await service.proposal(token, parts[0]!, parts[2]!));
      return;
    }
    if (request.method === 'POST' && parts.length === 3 && parts[1] === 'proposals') {
      const input = await body(request, 1024 * 1024);
      if (!input.ok) { send(response, input); return; }
      const result = await service.actProposal(token, parts[0]!, parts[2]!, input.data);
      send(response, result.ok ? success(result.data) : result);
      return;
    }
    send(response, failure('NOT_FOUND', '销售 Case 接口不存在'));
  };
}
