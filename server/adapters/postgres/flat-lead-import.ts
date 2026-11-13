import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { importRowIssue, type ImportReceipt, type ImportReceiptRow, type ImportRequest } from '../../core/leads';
import { normalizeImportCustomerType, normalizeImportEmail, unmatchedImportRemark } from '../../core/lead-import-fields';
import type { LeadIngressInput } from '../../core/lead-ingress';
import type { LeadActor } from './lead-repository';
import { evaluateLeadIngressIn, materializeLeadIngressIn } from './lead-match-repository';
import { recordImportOverlapsIn } from './lead-overlap-repository';

const optional = (value: string | undefined): string | null => value?.trim() || null;
const attemptKey = (key: string, index: number): string => `${key.slice(0, 120)}:${index}`;

function ingressSource(source: string): LeadIngressInput['source'] {
  return source.toLowerCase().includes('agent') ? 'agent_import' : 'flat_import';
}

/** One conflict gateway serves flat import and legacy Agent submissions. */
export async function importFlatLeadsIn(c: PoolClient, actor: LeadActor, input: ImportRequest): Promise<ImportReceipt> {
  const batchId = randomUUID();
  await c.query('INSERT INTO crm_import_batches(batch_id,actor_id,source,source_detail,mapping) VALUES($1,$2,$3,$4,$5)', [batchId, actor.userId, input.source, input.sourceDetail, JSON.stringify(input.mapping ?? {})]);
  const rows: ImportReceiptRow[] = [];
  for (const [index, original] of input.rows.entries()) {
    const sourceEmail = input.mapping?.email && original.rawRow ? String(original.rawRow[input.mapping.email] ?? original.email) : original.email;
    const normalizedEmail = normalizeImportEmail(sourceEmail);
    const normalizedCustomerType = normalizeImportCustomerType(original.customerType ?? '');
    const unmatched = unmatchedImportRemark(original.rawRow, Object.values(input.mapping ?? {}));
    const row = {
      ...original,
      customerKey: original.customerKey.trim(),
      companyName: original.companyName.trim(),
      email: normalizedEmail.email,
      customerType: normalizedCustomerType,
      remark: [
        unmatched,
        normalizedEmail.extras.length ? `其他邮箱：${normalizedEmail.extras.join('；')}` : '',
        normalizedCustomerType && normalizedCustomerType !== original.customerType?.trim() ? `原始客户类型：${original.customerType}` : '',
      ].filter(Boolean).join('\n'),
    };
    const rowId = randomUUID();
    let status: ImportReceiptRow['status'] = 'created';
    let message = importRowIssue(row);
    let customerId: string | undefined;
    let conflict: ImportReceiptRow['conflict'];
    let overlapCount = 0;
    if (message) status = 'invalid';
    else {
      const existing = (await c.query(`SELECT customer_id,company_id FROM crm_customers
        WHERE source=$1 AND customer_key=$2 AND origin=$3 AND owner_user_id IS NOT DISTINCT FROM $4
        FOR UPDATE`, [input.source, row.customerKey, input.kind ?? 'operations', input.kind === 'personal' ? actor.userId : null])).rows[0];
      const ingress: LeadIngressInput = {
        source: ingressSource(input.source), sourceChannel: input.source, sourceDetail: input.sourceDetail, kind: input.kind ?? 'operations',
        idempotencyKey: attemptKey(input.idempotencyKey, index), customerKey: row.customerKey,
        company: {
          name: row.companyName, domain: optional(row.website), country: optional(row.country),
          customerType: optional(row.customerType), businessType: optional(row.businessType),
        },
        contacts: [{
          email: optional(row.email), name: optional(row.name), firstName: optional(row.firstName), lastName: optional(row.lastName),
          title: optional(row.title), phone: optional(row.phone), whatsapp: optional(row.whatsapp), linkedinUrl: optional(row.linkedinUrl),
          country: optional(row.country), language: optional(row.language), clientType: optional(row.clientType),
          sourceLevel1: optional(row.sourceLevel1), sourceLevel2: optional(row.sourceLevel2), stage: optional(row.stage), status: optional(row.status),
          tags: row.tags ?? [], extra: row.remark ? { note: row.remark } : {},
        }],
        ...(existing ? { target: { customerId: existing.customer_id, companyId: existing.company_id }, checkCompany: true } : {}),
      };
      const evaluated = await evaluateLeadIngressIn(c, actor, ingress, { autoRestore: true });
      if (!evaluated.ok) {
        status = 'restricted_conflict'; message = evaluated.error.message;
      } else if (evaluated.data.assessment.status === 'duplicate') {
        status = 'duplicate'; customerId = evaluated.data.assessment.candidate?.customerId ?? existing?.customer_id;
        message = evaluated.data.assessment.message;
      } else if (evaluated.data.assessment.status === 'restricted_conflict') {
        status = 'restricted_conflict'; message = evaluated.data.assessment.message;
      } else if (evaluated.data.assessment.status === 'needs_resolution') {
        status = 'restricted_conflict'; message = evaluated.data.assessment.message;
        conflict = { decisionId: evaluated.data.decision.decisionId, level: evaluated.data.decision.level, candidates: evaluated.data.decision.candidates };
      } else {
        const restored=evaluated.data.application;
        const applied=restored?{ok:true as const,data:restored}:await materializeLeadIngressIn(c, actor, ingress, 'create_new');
        if (!applied.ok) {
          status = 'restricted_conflict'; message = applied.error.message;
        } else {
          customerId = applied.data.customerId;
          overlapCount = await recordImportOverlapsIn(c, applied.data.customerId, applied.data.contactIds ?? []);
          status = applied.data.createdContactIds?.length === 0 && applied.data.restoredContactIds.length === 0 ? 'duplicate' : 'created';
        }
      }
    }
    await c.query('INSERT INTO crm_import_rows(row_id,batch_id,row_index,customer_key,raw_row,customer_id,status) VALUES($1,$2,$3,$4,$5,$6,$7)', [rowId, batchId, index, row.customerKey, JSON.stringify({ input: row, rawRow: row.rawRow ?? original }), customerId ?? null, status]);
    if (overlapCount && !message) message = `已导入，发现 ${overlapCount} 条范围重叠`;
    rows.push({ rowId, index, status, ...(customerId ? { customerId } : {}), ...(message ? { message } : {}), ...(conflict ? { conflict } : {}), ...(overlapCount ? { overlapCount } : {}) });
  }
  return { batchId, version: 1, rows };
}
