import { failure } from '../core/crm';
import { TEAM_LIMITS, TEAM_ROUTES } from '../core/teams';
import type { TeamService } from '../services/teams';
import { body, send, type BrowserHandler } from './http';

export function createTeamHandler(service: TeamService): BrowserHandler {
  return async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
    if (request.method === 'GET' && url.pathname === TEAM_ROUTES.context) {
      send(response, await service.context(token));
      return;
    }
    if (request.method === 'GET' && url.pathname === TEAM_ROUTES.candidates) {
      const query: Record<string, unknown> = {};
      for (const [key, value] of url.searchParams) {
        if (key in query) { send(response, failure('INVALID_INPUT', '查询参数重复')); return; }
        query[key] = ['limit', 'offset'].includes(key) ? Number(value) : value;
      }
      send(response, await service.candidates(token, query));
      return;
    }
    if (request.method === 'GET' && url.pathname === TEAM_ROUTES.events) {
      const subscription = await service.subscribeEvents(token, event => {
        if (!response.writableEnded) response.write(`data: ${JSON.stringify(event)}\n\n`);
      });
      if (!subscription.ok) { send(response, subscription); return; }
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
      response.write(': connected\n\n');
      const heartbeat = setInterval(() => { if (!response.writableEnded) response.write(': ping\n\n'); }, 15000);
      const close = () => { clearInterval(heartbeat); subscription.data(); };
      request.on('close', close);
      response.on('close', close);
      return;
    }
    if (request.method === 'GET' && url.pathname === TEAM_ROUTES.messages) {
      send(response, await service.messages(token, {
        ...(url.searchParams.get('teamId') ? { teamId: url.searchParams.get('teamId')! } : {}),
        memberUserId: url.searchParams.get('memberUserId') ?? '',
        limit: Number(url.searchParams.get('limit') ?? TEAM_LIMITS.page),
        ...(url.searchParams.get('beforeMessageId') ? { beforeMessageId: url.searchParams.get('beforeMessageId')! } : {}),
      }));
      return;
    }
    if (request.method === 'GET' && url.pathname === TEAM_ROUTES.directory) {
      send(response, await service.directory(token, { limit: Number(url.searchParams.get('limit') ?? TEAM_LIMITS.page) }));
      return;
    }
    if (request.method === 'GET' && url.pathname === TEAM_ROUTES.conversations) {
      send(response, await service.conversations(token, {
        ...(url.searchParams.get('teamId') ? { teamId: url.searchParams.get('teamId')! } : {}),
        limit: Number(url.searchParams.get('limit') ?? TEAM_LIMITS.page),
      }));
      return;
    }
    const file = /^\/api\/crm\/team-files\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'GET' && file) {
      const result = await service.readFile(token, file[1]!);
      if (!result.ok) { send(response, result); return; }
      response.writeHead(200, { 'Content-Type': result.data.meta.mimeType, 'Content-Length': String(result.data.data.byteLength), 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(result.data.meta.filename)}` });
      response.end(Buffer.from(result.data.data));
      return;
    }
    const detail = /^\/api\/crm\/teams\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'GET' && detail) {
      send(response, await service.detail(token, detail[1]!));
      return;
    }
    if (request.method !== 'POST') { send(response, failure('NOT_FOUND', '团队接口不存在')); return; }
    const input = await body(request, url.pathname === TEAM_ROUTES.files ? TEAM_LIMITS.fileBodyBytes : TEAM_LIMITS.bodyBytes);
    if (!input.ok) { send(response, input); return; }
    if (url.pathname === TEAM_ROUTES.teams) {
      send(response, await service.create(token, input.data));
      return;
    }
    if (url.pathname === TEAM_ROUTES.messages) {
      send(response, await service.sendMessage(token, input.data));
      return;
    }
    if (url.pathname === TEAM_ROUTES.messagesRead) {
      send(response, await service.markMessagesRead(token, input.data));
      return;
    }
    if (url.pathname === TEAM_ROUTES.messagesUnread) {
      send(response, await service.markMessagesUnread(token, input.data));
      return;
    }
    if (url.pathname === TEAM_ROUTES.presence) {
      send(response, await service.presence(token, input.data));
      return;
    }
    if (url.pathname === TEAM_ROUTES.files) {
      send(response, await service.uploadFile(token, input.data));
      return;
    }
    if (url.pathname === TEAM_ROUTES.archive) {
      send(response, await service.archiveConversation(token, input.data));
      return;
    }
    const invite = /^\/api\/crm\/teams\/([^/]+)\/invitations$/.exec(url.pathname);
    if (invite) {
      send(response, await service.invite(token, invite[1]!, input.data));
      return;
    }
    const move = /^\/api\/crm\/teams\/([^/]+)\/move$/.exec(url.pathname);
    if (move) {
      send(response, await service.move(token, move[1]!, input.data));
      return;
    }
    const dissolve = /^\/api\/crm\/teams\/([^/]+)\/dissolve$/.exec(url.pathname);
    if (dissolve) {
      send(response, await service.dissolve(token, dissolve[1]!, input.data));
      return;
    }
    const leader = /^\/api\/crm\/teams\/([^/]+)\/leader$/.exec(url.pathname);
    if (leader) {
      send(response, await service.assignLeader(token, leader[1]!, input.data));
      return;
    }
    const member = /^\/api\/crm\/teams\/([^/]+)\/members$/.exec(url.pathname);
    if (member) {
      send(response, await service.adjustMember(token, member[1]!, input.data));
      return;
    }
    const group = /^\/api\/crm\/teams\/([^/]+)\/groups$/.exec(url.pathname);
    if (group) {
      send(response, await service.saveMemberGroup(token, group[1]!, input.data));
      return;
    }
    const deleteGroup = /^\/api\/crm\/teams\/([^/]+)\/groups\/([^/]+)\/delete$/.exec(url.pathname);
    if (deleteGroup) {
      send(response, await service.deleteMemberGroup(token, deleteGroup[1]!, deleteGroup[2]!, input.data));
      return;
    }
    const decide = /^\/api\/crm\/team-invitations\/([^/]+)\/(accept|decline|cancel)$/.exec(url.pathname);
    if (decide) {
      send(response, await service.decide(token, decide[1]!, decide[2] as 'accept' | 'decline' | 'cancel', input.data));
      return;
    }
    send(response, failure('NOT_FOUND', '团队接口不存在'));
  };
}
