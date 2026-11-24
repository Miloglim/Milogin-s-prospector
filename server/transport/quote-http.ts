import type { QuoteService } from '../services/quotes';
import { QUOTE_ROUTES } from '../services/quotes';
import { failure } from '../core/crm';
import { body, send, type BrowserHandler } from './http';

const TOKEN = /^Bearer ([A-Za-z0-9_-]{43})$/;
const REVIEWS = `${QUOTE_ROUTES.list}/reviews`;
const REVIEW_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function createQuoteHandler(service: QuoteService): BrowserHandler {
  return async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== QUOTE_ROUTES.list && !url.pathname.startsWith(`${QUOTE_ROUTES.list}/`)) {
      send(response, failure('NOT_FOUND', '报价接口不存在'));
      return;
    }
    const token = TOKEN.exec(request.headers.authorization ?? '')?.[1] ?? '';
    if (!token) { send(response, failure('UNAUTHORIZED', '请先登录中心账号')); return; }
    if (request.method === 'GET' && url.pathname === QUOTE_ROUTES.list) {
      const limit = Number(url.searchParams.get('limit') ?? 25);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      send(response, await service.list(token, {
        caseId: url.searchParams.get('caseId') ?? undefined,
        messageKey: url.searchParams.get('messageKey') ?? undefined,
        limit, offset,
      }));
      return;
    }
    if (request.method === 'GET' && url.pathname === REVIEWS) {
      const limit = Number(url.searchParams.get('limit') ?? 25);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      send(response, await service.listReviews(token, {
        status: url.searchParams.get('status') ?? undefined, limit, offset,
      }));
      return;
    }
    const reviewParts = url.pathname.startsWith(`${REVIEWS}/`) ? url.pathname.slice(REVIEWS.length + 1).split('/').filter(Boolean) : [];
    if (request.method === 'POST' && reviewParts.length === 2 && reviewParts[1] === 'decision' && REVIEW_ID.test(reviewParts[0] ?? '')) {
      const input = await body(request, 16 * 1024);
      if (!input.ok) { send(response, input); return; }
      send(response, await service.decideReview(token, reviewParts[0]!, input.data));
      return;
    }
    if (request.method === 'POST' && url.pathname === QUOTE_ROUTES.upsert) {
      const input = await body(request, 2 * 1024 * 1024);
      if (!input.ok) { send(response, input); return; }
      send(response, await service.upsert(token, input.data));
      return;
    }
    const parts = url.pathname.slice(QUOTE_ROUTES.list.length + 1).split('/').filter(Boolean);
    if (request.method === 'GET' && parts.length === 1) { send(response, await service.detail(token, parts[0]!)); return; }
    if (request.method === 'POST' && parts.length === 2 && parts[1] === 'requery') {
      const input = await body(request, 2 * 1024 * 1024);
      if (!input.ok) { send(response, input); return; }
      send(response, await service.requery(token, parts[0]!, input.data));
      return;
    }
    if (request.method === 'POST' && parts.length === 2 && parts[1] === 'select') {
      const input = await body(request, 64 * 1024);
      if (!input.ok) { send(response, input); return; }
      send(response, await service.select(token, parts[0]!, input.data));
      return;
    }
    if (request.method === 'POST' && parts.length === 2 && parts[1] === 'review') {
      const input = await body(request, 64 * 1024);
      if (!input.ok) { send(response, input); return; }
      send(response, await service.review(token, parts[0]!, input.data));
      return;
    }
    send(response, failure('NOT_FOUND', '报价接口不存在'));
  };
}
