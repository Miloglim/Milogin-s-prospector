export const GLOBAL_STATUS_TOAST_DURATION_SECONDS = 5;

export type GlobalStatusNotice = {
  key: 'offline' | 'center-unavailable' | 'feature-unavailable';
  type: 'warning' | 'info';
  content: string;
};

const LOCAL_ROUTES = new Set(['/customers', '/customers-online', '/account', '/messages']);

export function globalStatusNotices(input: {
  offline: boolean;
  centerUnavailable: boolean;
  localAvailable: boolean;
  pathname: string;
}): GlobalStatusNotice[] {
  const notices: GlobalStatusNotice[] = [];
  if (input.offline) notices.push({ key: 'offline', type: 'warning', content: '离线 · 本地工作区' });
  if (input.centerUnavailable) notices.push({ key: 'center-unavailable', type: 'info', content: '此页面需要连接服务器' });
  if (!input.localAvailable && !LOCAL_ROUTES.has(input.pathname)) {
    notices.push({ key: 'feature-unavailable', type: 'info', content: '此功能暂未开放' });
  }
  return notices;
}
