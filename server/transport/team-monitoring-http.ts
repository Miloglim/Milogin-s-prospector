import { failure } from '../core/crm';
import { TEAM_MONITORING_LIMITS, TEAM_MONITORING_ROUTES } from '../core/team-monitoring';
import type { TeamMonitoringService } from '../services/team-monitoring';
import { send, type BrowserHandler } from './http';

const TOKEN = /^Bearer ([A-Za-z0-9_-]{43})$/;
const MEMBER_PATH = /^\/api\/crm\/team-monitoring\/members\/([a-f0-9-]{36})$/i;
const CONTACT_PATH = /^\/api\/crm\/team-monitoring\/contacts\/(\d+)$/;
const MAIL_PATH = /^\/api\/crm\/team-monitoring\/mail\/([a-f0-9-]{36})$/i;

function validQuery(url: URL, allowed: readonly string[]): boolean {
  return [...url.searchParams.keys()].every(key => allowed.includes(key) && url.searchParams.getAll(key).length === 1);
}

function optional(url: URL, key: string): string | undefined {
  return url.searchParams.has(key) ? url.searchParams.get(key)! : undefined;
}

export function createTeamMonitoringHandler(service: TeamMonitoringService): BrowserHandler {
  return async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    const token = TOKEN.exec(request.headers.authorization ?? '')?.[1] ?? '';
    if (!token) { send(response, failure('UNAUTHORIZED', '会话无效')); return; }
    if (request.method !== 'GET') { send(response, failure('NOT_FOUND', '监控接口不存在')); return; }

    if (url.pathname === TEAM_MONITORING_ROUTES.overview) {
      if (!validQuery(url, ['teamId', 'memberUserId', 'limit', 'offset', 'unitLimit', 'unitOffset'])) {
        send(response, failure('INVALID_INPUT', '团队监控查询参数无效')); return;
      }
      send(response, await service.overview(token, {
        ...(optional(url, 'teamId') ? { teamId: optional(url, 'teamId') } : {}),
        ...(optional(url, 'memberUserId') ? { memberUserId: optional(url, 'memberUserId') } : {}),
        limit: Number(url.searchParams.get('limit') ?? TEAM_MONITORING_LIMITS.page),
        offset: Number(url.searchParams.get('offset') ?? 0),
        unitLimit: Number(url.searchParams.get('unitLimit') ?? TEAM_MONITORING_LIMITS.unitPage),
        unitOffset: Number(url.searchParams.get('unitOffset') ?? 0),
      }));
      return;
    }

    const member = MEMBER_PATH.exec(url.pathname);
    if (member) {
      if (!validQuery(url, ['limit', 'offset'])) { send(response, failure('INVALID_INPUT', '成员监控查询参数无效')); return; }
      send(response, await service.member(token, member[1]!, {
        limit: Number(url.searchParams.get('limit') ?? TEAM_MONITORING_LIMITS.mailPage),
        offset: Number(url.searchParams.get('offset') ?? 0),
      }));
      return;
    }

    const contact = CONTACT_PATH.exec(url.pathname);
    if (contact) {
      if (!validQuery(url, ['customerId', 'limit', 'offset'])) { send(response, failure('INVALID_INPUT', '联系人监控查询参数无效')); return; }
      send(response, await service.contact(token, contact[1]!, {
        customerId: optional(url, 'customerId'),
        limit: Number(url.searchParams.get('limit') ?? TEAM_MONITORING_LIMITS.mailPage),
        offset: Number(url.searchParams.get('offset') ?? 0),
      }));
      return;
    }

    const mail = MAIL_PATH.exec(url.pathname);
    if (mail) {
      if (!validQuery(url, ['contactId', 'customerId'])) { send(response, failure('INVALID_INPUT', '邮件监控查询参数无效')); return; }
      send(response, await service.mail(token, mail[1]!, {
        contactId: Number(url.searchParams.get('contactId')),
        customerId: optional(url, 'customerId'),
      }));
      return;
    }

    send(response, failure('NOT_FOUND', '监控接口不存在'));
  };
}
