import type { CenterContactRef } from '../../shared/online-crm';
import { createCampaign, updateCampaignDraft, type CampaignTouch } from './campaign.service';
import { getDb } from '../db';
import { sendCampaigns, sendCampaignTargets } from '../db/schema';
import { eq } from 'drizzle-orm';
import { Log } from '../logger';
import type { Result } from '../errors';

const PREPARED_TOUCHES: CampaignTouch[] = [
  { stage: 'initial', delayDays: 0, mode: 'system' },
  { stage: 'followup1', delayDays: 4, mode: 'system' },
  { stage: 'followup2', delayDays: 7, mode: 'system' },
  { stage: 'closing', delayDays: 10, mode: 'system' },
];

const MAX_PREPARED_CONTACTS = 1000;

function alreadyPrepared(caseIds: string[]): boolean {
  const wanted = new Set(caseIds.filter(Boolean));
  if (!wanted.size) return false;
  try {
    const rows = getDb().select({ filter: sendCampaigns.targetFilterJson }).from(sendCampaigns).all();
    return rows.some(row => {
      try {
        const value = JSON.parse(row.filter) as { salesCaseIds?: unknown };
        return Array.isArray(value.salesCaseIds) && value.salesCaseIds.some(id => wanted.has(String(id)));
      } catch { /* a malformed historical filter cannot block a new safe draft */ return false; }
    });
  } catch { /* database readiness is handled by the caller's regular startup path */ return false; }
}

function openDraft(groupKey: string): { id: string; name: string; caseIds: string[]; refs: CenterContactRef[]; count: number } | null {
  if (!groupKey) return null;
  const db = getDb();
  const rows = db.select().from(sendCampaigns).where(eq(sendCampaigns.status, 'draft')).all();
  const matches = rows.filter(row => {
    try {
      const value = JSON.parse(row.targetFilterJson) as { preparedBy?: string; groupKey?: string };
      return value.preparedBy === 'sales_workflow' && value.groupKey === groupKey;
    } catch { return false; }
  });
  const found = matches.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(row => {
    const targets = db.select({ centerReferenceJson: sendCampaignTargets.centerReferenceJson }).from(sendCampaignTargets).where(eq(sendCampaignTargets.campaignId, row.id)).all();
    const refs = targets.flatMap(target => {
      try { const value = JSON.parse(target.centerReferenceJson || '{}') as { reference?: CenterContactRef }; return value.reference ? [value.reference] : []; }
      catch { return []; }
    });
    const filter = JSON.parse(row.targetFilterJson) as { salesCaseIds?: unknown };
    return { id: row.id, name: row.name, caseIds: Array.isArray(filter.salesCaseIds) ? filter.salesCaseIds.map(String) : [], refs, count: targets.length };
  }).find(item => item.count < MAX_PREPARED_CONTACTS);
  return found ?? null;
}

export interface PreparedCampaignDraft {
  campaignId: string;
  name: string;
  eligible: number;
  caseIds: string[];
}

/** Turns verified contacts into one reviewable Campaign draft; it never starts SMTP. */
export function prepareCampaignDraft(input: {
  refs: CenterContactRef[];
  caseIds: string[];
  name: string;
  importBatchId?: string;
  groupKey?: string;
}): Result<PreparedCampaignDraft> {
  const refs = input.refs.filter((ref, index, all) => all.findIndex(item => item.contactId === ref.contactId && item.customerId === ref.customerId) === index);
  const caseIds = [...new Set(input.caseIds.filter(Boolean))];
  if (!refs.length) return { success: false, error: '没有可准备的开发联系人' };
  if (alreadyPrepared(caseIds)) return { success: false, error: '客户开发任务已经准备' };
  const existing = input.groupKey ? openDraft(input.groupKey) : null;
  if (existing) {
    const existingIds = new Set(existing.refs.map(ref => ref.contactId));
    const mergedRefs = [...existing.refs, ...refs.filter(ref => !existingIds.has(ref.contactId))];
    const mergedCases = [...new Set([...existing.caseIds, ...caseIds])];
    const updated = updateCampaignDraft(existing.id, {
      name: existing.name,
      contactIds: mergedRefs.map(ref => ref.contactId),
      centerContactRefs: mergedRefs,
      touches: PREPARED_TOUCHES,
      autoSend: false,
      startNow: false,
      createdBy: 'ui',
      accountPolicy: { mode: 'rotate' },
      schedule: { windowStartHour: 9, windowEndHour: 18 },
      sendMode: 'individual',
      targetFilter: { preparedBy: 'sales_workflow', groupKey: input.groupKey, importBatchId: input.importBatchId ?? null, salesCaseIds: mergedCases, source: 'verified_leads' },
    });
    if (!updated.success) return updated;
    Log.info('sales-workflow.campaign', `已扩充客户开发草稿 ${existing.id}：${updated.data.eligible} 人，未启动发送`);
    return { success: true, data: { campaignId: existing.id, name: updated.data.name, eligible: updated.data.eligible, caseIds: mergedCases } };
  }
  const result = createCampaign({
    name: input.name,
    contactIds: refs.map(ref => ref.contactId),
    centerContactRefs: refs,
    touches: PREPARED_TOUCHES,
    autoSend: false,
    startNow: false,
    createdBy: 'ui',
    accountPolicy: { mode: 'rotate' },
    schedule: { windowStartHour: 9, windowEndHour: 18 },
    sendMode: 'individual',
    targetFilter: {
      preparedBy: 'sales_workflow',
      preparedAt: new Date().toISOString(),
      importBatchId: input.importBatchId ?? null,
      groupKey: input.groupKey ?? null,
      salesCaseIds: caseIds,
      source: 'verified_leads',
    },
  });
  if (!result.success) return result;
  Log.info('sales-workflow.campaign', `已准备客户开发草稿 ${result.data.id}：${result.data.eligible} 人，未启动发送`);
  return { success: true, data: { campaignId: result.data.id, name: result.data.name, eligible: result.data.eligible, caseIds } };
}

/** Contacts accepted one-by-one share a small daily draft instead of creating one task per lead. */
export function prepareAssignmentDraft(refs: CenterContactRef[], caseIds: string[]): Result<PreparedCampaignDraft> {
  const day = new Date().toISOString().slice(0, 10);
  return prepareCampaignDraft({ refs, caseIds, name: `新分配线索 ${day}`, groupKey: `assignment:${day}` });
}
