export interface NavigatorUser { user_id: number | string; name: string; display_name: string; role: string }
export interface NavigatorStatus { authenticated: boolean; user?: NavigatorUser; baseUrl: string }
export interface NavigatorResult<T> { ok: boolean; data?: T; error?: string; code?: string }
export interface NavigatorQuery { rows: Record<string, unknown>[]; total: number; queryId: string }
export interface NavigatorChoice { n: string; c?: string; e?: string; a?: string; k?: string; l?: string }
export interface NavigatorOptions { ports: NavigatorChoice[]; portGroups: NavigatorChoice[]; carriers: NavigatorChoice[]; routes: NavigatorChoice[] }
export const NAVIGATOR_CLIENT_ID = 'prospector';
export const NAVIGATOR_CALLBACK_PATH = '/navigator/callback';
