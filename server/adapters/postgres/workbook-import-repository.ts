import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { success, type Result } from '../../core/crm';
import { normalizeSourceDate, workbookRowIssue, type WorkbookImportRequest, type WorkbookImportReceipt, type WorkbookImportRow, type WorkbookReceiptRow } from '../../core/customer-import';
import type { LeadIngressInput } from '../../core/lead-ingress';
import type { LeadIngressCandidateDTO } from '../../core/lead-ingress';
import type { LeadConflictLevel } from '../../core/lead-conflict';
import type { LeadActor } from './lead-repository';
import { evaluateLeadIngressIn, materializeLeadIngressIn } from './lead-match-repository';

type CustomerRecord = { customer_id: string; company_id: number; created_by: string; origin: string; owner_user_id: string | null; state: string; version: number; company_name: string; country: string | null; customer_type: string | null; business_type: string | null; development_restriction: string | null; source_created_at: Date | null };
type WorkbookOutcome = Pick<WorkbookReceiptRow,'status'|'customerId'|'message'> & { conflict?: { decisionId:string; level:LeadConflictLevel; candidates:LeadIngressCandidateDTO[] } };
const value = (input: string | undefined): string | null => input?.trim() || null;
const attemptKey = (key: string, index: number): string => `${key.slice(0, 120)}:${index}`;

function customerMatches(row: WorkbookImportRow, current: CustomerRecord): boolean {
  return current.company_name === row.companyName?.trim() && current.country === value(row.country) && current.customer_type === value(row.customerType)
    && current.business_type === value(row.businessType) && current.development_restriction === value(row.developmentRestriction)
    && (current.source_created_at?.toISOString() ?? null) === (row.sourceCreatedAt ? normalizeSourceDate(row.sourceCreatedAt) : null);
}
function editable(actor: LeadActor, customer: CustomerRecord, kind: WorkbookImportRequest['kind']): boolean {
  return customer.created_by === actor.userId && customer.origin === kind
    && (kind === 'personal' ? customer.state === 'owned' && customer.owner_user_id === actor.userId : customer.state === 'draft' && customer.owner_user_id === null);
}
async function mapping(c: PoolClient, actor: LeadActor, input: WorkbookImportRequest, entity: string, ref: string) {
  return (await c.query('SELECT * FROM crm_workbook_source_mappings WHERE actor_id=$1 AND source=$2 AND origin=$3 AND entity=$4 AND source_ref=$5', [actor.userId, input.source, input.kind, entity, ref])).rows[0];
}
async function customer(c: PoolClient, id: string): Promise<CustomerRecord | undefined> {
  return (await c.query(`SELECT cu.*,co.name AS company_name,co.country,co.customer_type FROM crm_customers cu JOIN companies co ON co.id=cu.company_id WHERE cu.customer_id=$1 FOR UPDATE OF cu`, [id])).rows[0];
}
async function saveMapping(c: PoolClient, actor: LeadActor, input: WorkbookImportRequest, row: WorkbookImportRow, customerId: string, contactId?: number) {
  await c.query(`INSERT INTO crm_workbook_source_mappings(
    actor_id,source,origin,entity,source_ref,customer_ref,customer_id,contact_id
  ) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`, [
    actor.userId,input.source,input.kind,row.entity,row.sourceRef.trim(),row.entity === 'customer' ? row.sourceRef.trim() : row.customerRef!.trim(),customerId,contactId ?? null,
  ]);
}
function contactMatches(row: WorkbookImportRow, current: Record<string, unknown>): boolean {
  const expected = contactValues(row);
  return Object.entries(expected).every(([key,item]) => key === 'tags' ? JSON.stringify(current[key]) === JSON.stringify(item) : current[key] === item);
}
function contactValues(row: WorkbookImportRow): Record<string, unknown> {
  return {
    email:value(row.email)?.toLowerCase() ?? null, first_name:value(row.firstName ?? row.name), last_name:value(row.lastName),
    country:value(row.country), phone:value(row.phone), whatsapp:value(row.whatsapp), title:value(row.title),
    linkedin:value(row.linkedinUrl), language:value(row.language), client_type:value(row.clientType),
    source_level1:value(row.sourceLevel1), source_level2:value(row.sourceLevel2), stage:value(row.stage) ?? 'cold', status:value(row.status) ?? '', tags:row.tags ?? [],
  };
}

function ingressBase(input: WorkbookImportRequest, row: WorkbookImportRow, index: number, current?: CustomerRecord): LeadIngressInput {
  const contact = {
    email:value(row.email)?.toLowerCase(), name:value(row.name), firstName:value(row.firstName), lastName:value(row.lastName),
    title:value(row.title), phone:value(row.phone), whatsapp:value(row.whatsapp), linkedinUrl:value(row.linkedinUrl),
    country:value(row.country), language:value(row.language), clientType:value(row.clientType),
    sourceLevel1:value(row.sourceLevel1), sourceLevel2:value(row.sourceLevel2), stage:value(row.stage), status:value(row.status), tags:row.tags ?? [],
  };
  return {
    source:'workbook_import', sourceChannel:input.source, sourceDetail:input.sourceDetail, kind:input.kind,
    idempotencyKey:attemptKey(input.idempotencyKey,index), customerKey:row.entity==='customer'?'':row.customerRef?.trim()||row.sourceRef.trim(),
    company:{
      name:row.companyName?.trim() || current?.company_name || 'Unknown company',
      country:value(row.country) ?? current?.country ?? null,
      customerType:value(row.customerType) ?? current?.customer_type ?? null,
      businessType:value(row.businessType),
    },
    contacts:row.entity === 'contact' ? [contact] : [],
    profile:{ developmentRestriction:value(row.developmentRestriction), sourceCreatedAt:value(row.sourceCreatedAt) },
    references:{ sourceRef:row.sourceRef.trim(), customerRef:row.customerRef?.trim(), entity:row.entity },
    ...(current ? { target:{ customerId:current.customer_id } } : {}),
  };
}

async function importCustomer(c: PoolClient, actor: LeadActor, input: WorkbookImportRequest, row: WorkbookImportRow, index: number): Promise<WorkbookOutcome> {
  const linked = await mapping(c, actor, input, 'customer', row.sourceRef.trim());
  const current = linked ? await customer(c, linked.customer_id) : undefined;
  const ingress = ingressBase(input,row,index,current);
  const evaluated = await evaluateLeadIngressIn(c, actor, ingress);
  if (!evaluated.ok) return { status:'restricted_conflict', message:evaluated.error.message };
  if (evaluated.data.assessment.status === 'restricted_conflict') return { status:'restricted_conflict', message:evaluated.data.assessment.message };
  if (evaluated.data.assessment.status === 'needs_resolution') return {
    status:'restricted_conflict', message:evaluated.data.assessment.message,
    conflict:{ decisionId:evaluated.data.decision.decisionId, level:evaluated.data.decision.level, candidates:evaluated.data.decision.candidates },
  };
  if (linked) {
    if (!current || !editable(actor,current,input.kind)) return { status:'restricted_conflict', message:'需核实来源或客户归属' };
    if (!customerMatches(row,current)) return { status:'ambiguous', customerId:current.customer_id, message:'来源客户资料已变化，请核对后修改主档' };
    return { status:'duplicate', customerId:current.customer_id };
  }
  const applied = await materializeLeadIngressIn(c, actor, ingress, 'create_new');
  if (!applied.ok) return { status:'restricted_conflict', message:applied.error.message };
  await saveMapping(c,actor,input,row,applied.data.customerId);
  return { status:'created', customerId:applied.data.customerId };
}

async function importContact(c: PoolClient, actor: LeadActor, input: WorkbookImportRequest, row: WorkbookImportRow, index: number, blocked: Set<string>): Promise<WorkbookOutcome> {
  const parentRef = row.customerRef!.trim();
  if (blocked.has(parentRef)) return { status:'ambiguous', message:'来源客户资料待核对' };
  const parent = await mapping(c, actor, input, 'customer', parentRef);
  if (!parent) return { status:'unmatched', message:'缺少已确认的来源客户关联' };
  const current = await customer(c,parent.customer_id);
  if (!current || !editable(actor,current,input.kind)) return { status:'restricted_conflict', message:'需核实来源或客户归属' };
  const linked = await mapping(c, actor, input, 'contact', row.sourceRef.trim());
  const ingress = ingressBase(input,row,index,current);
  if (linked) ingress.target = { ...ingress.target, contactId:linked.contact_id };
  const evaluated = await evaluateLeadIngressIn(c, actor, ingress, { autoRestore:true });
  if (!evaluated.ok) return { status:'restricted_conflict', message:evaluated.error.message };
  if (evaluated.data.assessment.status === 'restricted_conflict') return { status:'restricted_conflict', message:evaluated.data.assessment.message };
  if (evaluated.data.assessment.status === 'needs_resolution') return {
    status:'restricted_conflict', message:evaluated.data.assessment.message,
    conflict:{ decisionId:evaluated.data.decision.decisionId, level:evaluated.data.decision.level, candidates:evaluated.data.decision.candidates },
  };
  if (linked) {
    if (linked.customer_id !== current.customer_id || linked.customer_ref !== parentRef) return { status:'ambiguous', message:'联系人所属客户已变化，请核对关联' };
    const rowContact = (await c.query('SELECT * FROM contacts WHERE id=$1',[linked.contact_id])).rows[0];
    if (!rowContact || !contactMatches(row,rowContact)) return { status:'ambiguous', customerId:current.customer_id, message:'来源联系人资料已变化，请核对后修改主档' };
  }
  if (evaluated.data.assessment.status === 'duplicate') {
    if (!linked) await saveMapping(c,actor,input,row,current.customer_id,evaluated.data.assessment.candidate?.contactId);
    return { status:'duplicate', customerId:current.customer_id };
  }
  const restored=evaluated.data.application;
  const applied=restored?{ok:true as const,data:restored}:await materializeLeadIngressIn(c,actor,ingress,'create_new');
  if (!applied.ok) return { status:'restricted_conflict', customerId:current.customer_id, message:applied.error.message };
  if (!linked) await saveMapping(c,actor,input,row,current.customer_id,applied.data.contactIds[0]);
  return { status:applied.data.createdContactIds?.length===0&&applied.data.restoredContactIds.length===0?'duplicate':'appended', customerId:current.customer_id };
}

/** Caller owns authorization, advisory serialization, idempotency and the transaction. */
export async function importWorkbookIn(c: PoolClient, actor: LeadActor, input: WorkbookImportRequest): Promise<Result<WorkbookImportReceipt>> {
  const batchId = randomUUID();
  await c.query('INSERT INTO crm_import_batches(batch_id,actor_id,source,source_detail,mapping) VALUES($1,$2,$3,$4,$5)', [batchId, actor.userId, input.source, input.sourceDetail, JSON.stringify({ format:'workbook',kind:input.kind })]);
  const receipts = new Array<WorkbookReceiptRow>(input.rows.length), blocked = new Set<string>();
  for (const entity of ['customer','contact'] as const) for (const [index,row] of input.rows.entries()) {
    if (row.entity !== entity) continue;
    const issue = workbookRowIssue(row);
    const outcome = issue ? { status:'invalid' as const, message:issue } : entity === 'customer'
      ? await importCustomer(c,actor,input,row,index)
      : await importContact(c,actor,input,row,index,blocked);
    if (entity === 'customer' && !['created','duplicate'].includes(outcome.status)) blocked.add(row.sourceRef.trim());
    const receipt: WorkbookReceiptRow = { rowId:randomUUID(),index,entity,sheetName:row.sheetName,rowNumber:row.rowNumber,...outcome };
    await c.query('INSERT INTO crm_import_rows(row_id,batch_id,row_index,customer_key,raw_row,customer_id,status) VALUES($1,$2,$3,$4,$5,$6,$7)', [receipt.rowId,batchId,index,row.sourceRef,JSON.stringify({ input:row,rawRow:row.rawRow,entity,sheetName:row.sheetName,rowNumber:row.rowNumber }),outcome.customerId ?? null,outcome.status]);
    receipts[index] = receipt;
  }
  return success({ batchId, rows:receipts });
}
