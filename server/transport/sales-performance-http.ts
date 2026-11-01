import { failure } from '../core/crm';
import { SALES_PERFORMANCE_LIMITS, SALES_PERFORMANCE_ROUTES } from '../core/sales-performance';
import type { SalesPerformanceService } from '../services/sales-performance';
import { body, send, type BrowserHandler } from './http';

const TOKEN = /^Bearer ([A-Za-z0-9_-]{43})$/;
const OVERRIDE_PATH = /^\/api\/crm\/sales-performance\/customer-grades\/([a-f0-9-]{36})\/override$/i;

function validQuery(url: URL, allowed: readonly string[]): boolean {
  return [...url.searchParams.keys()].every(key => allowed.includes(key) && url.searchParams.getAll(key).length === 1);
}

function optional(url: URL, key: string): string | undefined {
  return url.searchParams.has(key) ? url.searchParams.get(key)! : undefined;
}

export function createSalesPerformanceHandler(service: SalesPerformanceService): BrowserHandler {
  return async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    const token = TOKEN.exec(request.headers.authorization ?? '')?.[1] ?? '';
    if (!token) { send(response, failure('UNAUTHORIZED', '会话无效')); return; }

    if (request.method === 'GET' && url.pathname === SALES_PERFORMANCE_ROUTES.performance) {
      if (!validQuery(url, ['from', 'to', 'groupBy', 'teamId', 'memberUserId', 'source', 'batchId', 'country', 'limit', 'offset'])) {
        send(response, failure('INVALID_INPUT', '销售绩效查询参数无效')); return;
      }
      send(response, await service.performance(token, {
        ...(optional(url, 'from') ? { from: optional(url, 'from') } : {}),
        ...(optional(url, 'to') ? { to: optional(url, 'to') } : {}),
        ...(optional(url, 'groupBy') ? { groupBy: optional(url, 'groupBy') } : {}),
        ...(optional(url, 'teamId') ? { teamId: optional(url, 'teamId') } : {}),
        ...(optional(url, 'memberUserId') ? { memberUserId: optional(url, 'memberUserId') } : {}),
        ...(optional(url, 'source') ? { source: optional(url, 'source') } : {}),
        ...(optional(url, 'batchId') ? { batchId: optional(url, 'batchId') } : {}),
        ...(optional(url, 'country') ? { country: optional(url, 'country') } : {}),
        limit: Number(url.searchParams.get('limit') ?? SALES_PERFORMANCE_LIMITS.page),
        offset: Number(url.searchParams.get('offset') ?? 0),
      }));
      return;
    }

    if (request.method === 'GET' && url.pathname === SALES_PERFORMANCE_ROUTES.customerGrades) {
      if (!validQuery(url, ['from', 'to', 'customerId', 'teamId', 'memberUserId', 'limit', 'offset'])) {
        send(response, failure('INVALID_INPUT', '客户分级查询参数无效')); return;
      }
      send(response, await service.customerGrades(token, {
        ...(optional(url, 'from') ? { from: optional(url, 'from') } : {}),
        ...(optional(url, 'to') ? { to: optional(url, 'to') } : {}),
        ...(optional(url, 'customerId') ? { customerId: optional(url, 'customerId') } : {}),
        ...(optional(url, 'teamId') ? { teamId: optional(url, 'teamId') } : {}),
        ...(optional(url, 'memberUserId') ? { memberUserId: optional(url, 'memberUserId') } : {}),
        limit: Number(url.searchParams.get('limit') ?? SALES_PERFORMANCE_LIMITS.page),
        offset: Number(url.searchParams.get('offset') ?? 0),
      }));
      return;
    }

    const override = OVERRIDE_PATH.exec(url.pathname);
    if (override && ['POST', 'DELETE'].includes(request.method ?? '')) {
      if (url.search) { send(response, failure('INVALID_INPUT', '客户等级覆盖不接受查询参数')); return; }
      const input = await body(request, SALES_PERFORMANCE_LIMITS.bodyBytes);
      if (!input.ok) { send(response, input); return; }
      send(response, request.method === 'POST'
        ? await service.setCustomerGradeOverride(token, override[1]!, input.data)
        : await service.clearCustomerGradeOverride(token, override[1]!, input.data));
      return;
    }

    send(response, failure('NOT_FOUND', '销售绩效接口不存在'));
  };
}
