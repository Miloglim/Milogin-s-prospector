import { failure } from '../core/crm';
import {
  TEAM_ATTENTION_LIMITS,
  TEAM_ATTENTION_ROUTES,
  type TeamAttentionTransitionAction,
} from '../core/team-attention';
import type { TeamAttentionService } from '../services/team-attention';
import { body, send, type BrowserHandler } from './http';

const TOKEN = /^Bearer ([A-Za-z0-9_-]{43})$/;
const QUERY_FIELDS = ['status', 'reason', 'targetMemberUserId', 'limit', 'offset'] as const;

export function createTeamAttentionHandler(service: TeamAttentionService): BrowserHandler {
  return async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    const token = TOKEN.exec(request.headers.authorization ?? '')?.[1] ?? '';
    if (!token) { send(response, failure('UNAUTHORIZED', '会话无效')); return; }
    if (url.pathname === TEAM_ATTENTION_ROUTES.items) {
      if (request.method === 'GET') {
        if ([...url.searchParams.keys()].some(key => !QUERY_FIELDS.includes(key as never) || url.searchParams.getAll(key).length !== 1)) { send(response, failure('INVALID_INPUT', '关注项查询参数无效')); return; }
        const status = url.searchParams.get('status') ?? undefined, reason = url.searchParams.get('reason') ?? undefined;
        send(response, await service.list(token, {
          ...(status ? { status } : {}), ...(reason ? { reason } : {}),
          ...(url.searchParams.has('targetMemberUserId') ? { targetMemberUserId: url.searchParams.get('targetMemberUserId')! } : {}),
          limit: Number(url.searchParams.get('limit') ?? TEAM_ATTENTION_LIMITS.page),
          offset: Number(url.searchParams.get('offset') ?? 0),
        }));
        return;
      }
      if (request.method === 'POST') {
        if (url.search) { send(response, failure('INVALID_INPUT', '创建关注项不接受查询参数')); return; }
        const input = await body(request, TEAM_ATTENTION_LIMITS.bodyBytes); send(response, input.ok ? await service.create(token, input.data) : input); return;
      }
      send(response, failure('NOT_FOUND', '关注项接口不存在')); return;
    }
    const action = /^\/api\/crm\/team-attention\/([^/]+)\/(acknowledge|dismiss|resolve)$/.exec(url.pathname);
    if (action && request.method === 'POST') {
      if (url.search) { send(response, failure('INVALID_INPUT', '关注项状态请求不接受查询参数')); return; }
      const input = await body(request, TEAM_ATTENTION_LIMITS.bodyBytes); send(response, input.ok ? await service.transition(token, action[1]!, action[2] as TeamAttentionTransitionAction, input.data) : input); return;
    }
    send(response, failure('NOT_FOUND', '关注项接口不存在'));
  };
}
