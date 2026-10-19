import type { LeadBootstrap, LeadDetail, LeadQuery } from '../../../server/core/leads';
import type { Result } from '../../../server/core/crm';

export const OFFLINE_CRM_LIMITS = { contactIdStart: 1_000_000_000_000, pageSize: 100, sync_interval_seconds: 15 } as const;
export interface OfflineCrmContext {
  userId: string; baseUrl: string; permissionKey: string;
  active(): boolean; online(): boolean;
}
export interface OfflineOperation {
  id: string; method: string; path: string; body: Record<string, unknown>;
  entities: string[]; dependency?: string; status: 'pending' | 'failed' | 'conflict';
  message?: string; response: unknown; wire?: {path:string;body:Record<string,unknown>};
  central?: LeadDetail;
  replayOnly?: boolean;
}
export interface OfflineCrmState {
  permissionKey: string; bootstrap?: LeadBootstrap; customers: Record<string, LeadDetail>;
  views: Partial<Record<LeadQuery['view'], string[]>>; cache: Record<string, unknown>;
  outbox: OfflineOperation[]; receipts: Record<string, {digest:string;response:unknown}>;
  aliases: Record<string,string>; contacts: Record<string,number>; versions: Record<string,number>;
  nextContactId: number; lastSyncedAt?: string; lastAttemptAt?: string; lastError?: string;
}
export interface OfflineCrmStore {
  load(context: OfflineCrmContext): OfflineCrmState;
  save(context: OfflineCrmContext, state: OfflineCrmState): void;
}
export type CrmNetwork = <T>(method:string,path:string,body?:unknown) => Promise<Result<T>>;
export function emptyOfflineCrmState(permissionKey:string):OfflineCrmState {
  return {permissionKey,customers:{},views:{},cache:{},outbox:[],receipts:{},aliases:{},contacts:{},versions:{},nextContactId:OFFLINE_CRM_LIMITS.contactIdStart};
}
