import type { CenterContact, CenterContactRef } from '../../shared/online-crm';
import { centerContactDisplayStatus } from '../../shared/online-crm';
import type { ContactRow } from '../db/schema/contacts';
import { okResult, failResult, type Result } from '../errors';
import type { SendAuthorization } from '../../../server/core/send-acceptance';

export interface CenterSendContact extends ContactRow {
  centerReference: CenterContactRef;
  centerScope: string;
  companyName: string;
}
export interface CenterSendRecipient { contactId: number; email: string; name: string; centerReference?: CenterContactRef }
export interface CenterSendItem {
  id: string; recipients: CenterSendRecipient[]; accountId: number; subject: string;
  centerScope?: string; campaignId?: string; companyName: string;
  cc?: string;
}
export interface CenterSendReceipt extends CenterSendItem {
  body: string; messageId: string | null; occurredAt: string; advanceSendStage: boolean;
  authorizations?: SendAuthorization[];
}
export interface CenterSendStats {
  neverIds: number[];
  lastSent: Array<{ id: number; label: string }>;
  inCampaign: Array<{ id: number; campaignName: string }>;
}
/** Only explicit center references may enter this port. No numeric-ID fallback. */
export interface CenterSendPort {
  contacts(): Result<CenterSendContact[]>;
  authorize(item: CenterSendItem): Promise<Result<void>>;
  record(receipt: CenterSendReceipt): Promise<Result<void>>;
  stats(): Result<CenterSendStats>;
  lastAccounts(ids: number[]): Map<number, number>;
  history?(): Result<Array<{id:number;contactId:number;email:string;firstName:string|null;lastName:string|null;companyName:string|null;subject:string|null;accountEmail:string|null;accountId?:number;sentAt:string}>>;
  clearHistory?(): Result<number>;
}
let port: CenterSendPort | null = null;
export function setCenterSendPort(value: CenterSendPort | null): void { port = value; }
export function getCenterSendPort(): CenterSendPort | null { return port; }
export function resolveCenterSendContacts(refs: CenterContactRef[]): Result<CenterSendContact[]> {
  if (!port) return failResult('中心联系人发送尚未就绪');
  if (!Array.isArray(refs) || !refs.length) return failResult('请选择联系人');
  const result = port.contacts(); if (!result.success) return result;
  const rows: CenterSendContact[] = []; const seen = new Set<string>();
  for (const ref of refs) {
    if (!ref || !Number.isSafeInteger(ref.contactId) || ref.contactId <= 0 || typeof ref.customerId !== 'string' || !ref.customerId) return failResult('中心联系人引用无效');
    const key = JSON.stringify([ref.contactId, ref.customerId]); if (seen.has(key)) continue;
    const row = result.data.find(c => c.id === ref.contactId && c.centerReference.customerId === ref.customerId);
    if (!row) return failResult('联系人已不在当前可开发名单中');
    rows.push(row); seen.add(key);
  }
  return okResult(rows);
}
export function centerSendContact(row: CenterContact, scope: string): CenterSendContact {
  return {
    id: row.contactId, centerReference: { contactId: row.contactId, customerId: row.customerId }, centerScope: scope,
    email: row.email ?? '', companyId: row.companyId, companyName: row.companyName,
    firstName: row.firstName, lastName: row.lastName, title: row.title, phone: row.phone,
    linkedinUrl: row.linkedinUrl, country: row.country, clientType: row.clientType, language: row.language,
    stage: row.stage, status: centerContactDisplayStatus(row), tags: JSON.stringify(row.tags), extra: JSON.stringify(row.extra),
    assignee: row.assignee, source: row.source, sourceDetail: row.sourceDetail, createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}
