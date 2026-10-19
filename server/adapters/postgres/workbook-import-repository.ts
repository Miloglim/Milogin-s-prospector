import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { success, type Result } from '../../core/crm';
import { normalizeSourceDate, workbookRowIssue, type WorkbookImportRequest, type WorkbookImportReceipt, type WorkbookImportRow, type WorkbookReceiptRow } from '../../core/customer-import';
import type { LeadActor } from './lead-repository';

type CustomerRecord = { customer_id: string; company_id: number; created_by: string; origin: string; owner_user_id: string | null; state: string; version: number; company_name: string; country: string | null; customer_type: string | null; business_type: string | null; development_restriction: string | null; source_created_at: Date | null };
function value(input: string | undefined): string | null { return input?.trim() || null; }
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
 await c.query('INSERT INTO crm_workbook_source_mappings(actor_id,source,origin,entity,source_ref,customer_ref,customer_id,contact_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [actor.userId, input.source, input.kind, row.entity, row.sourceRef.trim(), row.entity === 'customer' ? row.sourceRef.trim() : row.customerRef!.trim(), customerId, contactId ?? null]);
}
async function importCustomer(c: PoolClient, actor: LeadActor, input: WorkbookImportRequest, row: WorkbookImportRow): Promise<Pick<WorkbookReceiptRow, 'status' | 'customerId' | 'message'>> {
 const linked = await mapping(c, actor, input, 'customer', row.sourceRef.trim());
 if (linked) {
  const current = await customer(c, linked.customer_id);
  if (!current || !editable(actor, current, input.kind)) return { status: 'restricted_conflict', message: '需核实来源或客户归属' };
  if (!customerMatches(row, current)) return { status: 'ambiguous', customerId: current.customer_id, message: '来源客户资料已变化，请核对后修改主档' };
  return { status: 'duplicate', customerId: current.customer_id };
 }
 const co = await c.query('INSERT INTO companies(name,country,customer_type) VALUES($1,$2,$3) RETURNING id', [row.companyName!.trim(), value(row.country),value(row.customerType)]);
 const id = randomUUID();
 await c.query(`INSERT INTO crm_customers(customer_id,company_id,source,customer_key,source_detail,created_by,origin,state,owner_user_id,business_type,development_restriction,source_created_at) VALUES($1,$2,$3,$1::uuid::text,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, co.rows[0].id, input.source, input.sourceDetail, actor.userId, input.kind, input.kind === 'personal' ? 'owned' : 'draft', input.kind === 'personal' ? actor.userId : null, value(row.businessType), value(row.developmentRestriction), row.sourceCreatedAt ? normalizeSourceDate(row.sourceCreatedAt) : null]);
 await saveMapping(c, actor, input, row, id);
 if (input.kind === 'personal') await event(c, actor, id, 1, 'crm.customer.created');
 return { status: 'created', customerId: id };
}
function contactValues(row:WorkbookImportRow):Record<string,unknown>{return {email:value(row.email)?.toLowerCase()??null,first_name:value(row.firstName??row.name),last_name:value(row.lastName),country:value(row.country),phone:value(row.phone),whatsapp:value(row.whatsapp),title:value(row.title),linkedin:value(row.linkedinUrl),language:value(row.language),client_type:value(row.clientType),source_level1:value(row.sourceLevel1),source_level2:value(row.sourceLevel2),stage:value(row.stage)??'cold',status:value(row.status)??'',tags:row.tags??[]};}
function contactMatches(row: WorkbookImportRow, current: Record<string, unknown>): boolean {
 return Object.entries(contactValues(row)).every(([key,v])=>key==='tags'?JSON.stringify(current[key])===JSON.stringify(v):current[key]===v);
}
async function importContact(c: PoolClient, actor: LeadActor, input: WorkbookImportRequest, row: WorkbookImportRow, blocked: Set<string>): Promise<Pick<WorkbookReceiptRow, 'status' | 'customerId' | 'message'>> {
 const parentRef = row.customerRef!.trim();
 if (blocked.has(parentRef)) return { status: 'ambiguous', message: '来源客户资料待核对' };
 const parent = await mapping(c, actor, input, 'customer', parentRef);
 if (!parent) return { status: 'unmatched', message: '缺少已确认的来源客户关联' };
 const current = await customer(c, parent.customer_id);
 if (!current || !editable(actor, current, input.kind)) return { status: 'restricted_conflict', message: '需核实来源或客户归属' };
 const linked = await mapping(c, actor, input, 'contact', row.sourceRef.trim());
 if (linked) {
  if (linked.customer_id !== current.customer_id || linked.customer_ref !== parentRef) return { status: 'ambiguous', message: '联系人所属客户已变化，请核对关联' };
  const co = (await c.query('SELECT * FROM contacts WHERE id=$1', [linked.contact_id])).rows[0];
  if (co&&(await c.query("SELECT 1 FROM crm_contact_assignment_requests WHERE contact_id=$1 AND status IN ('pending','accepted')",[co.id])).rows.length)return {status:'restricted_conflict',message:'联系人已进入独立分配流程'};
  if (!co || !contactMatches(row, co)) return { status: 'ambiguous', customerId: current.customer_id, message: '来源联系人资料已变化，请核对后修改主档' };
  return { status: 'duplicate', customerId: current.customer_id };
 }
 const email = value(row.email)?.toLowerCase() ?? null;
 if (email) {
  const existing = (await c.query('SELECT co.*,cc.customer_id FROM contacts co LEFT JOIN crm_customer_contacts cc ON cc.contact_id=co.id WHERE co.email=$1', [email])).rows[0];
  if (existing) {
   if (existing.customer_id !== current.customer_id) return { status: 'restricted_conflict', message: '联系人信息冲突，请核实来源' };
   if (!contactMatches(row, existing)) return { status: 'ambiguous', customerId: current.customer_id, message: '已有联系人资料不一致，请核对' };
   await saveMapping(c, actor, input, row, current.customer_id, existing.id);
   return { status: 'duplicate', customerId: current.customer_id };
  }
 }
 const fields=contactValues(row);const co = await c.query('INSERT INTO contacts(email,company_id,first_name,last_name,country,phone,whatsapp,title,linkedin,language,client_type,source_level1,source_level2,stage,status,tags,source,source_detail) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18) RETURNING id', [email,current.company_id,fields.first_name,fields.last_name,fields.country,fields.phone,fields.whatsapp,fields.title,fields.linkedin,fields.language,fields.client_type,fields.source_level1,fields.source_level2,fields.stage,fields.status,JSON.stringify(fields.tags),input.source,input.sourceDetail]);
 await c.query('INSERT INTO crm_customer_contacts(customer_id,contact_id) VALUES($1,$2)', [current.customer_id, co.rows[0].id]);
 await saveMapping(c, actor, input, row, current.customer_id, co.rows[0].id);
 await c.query('UPDATE crm_customers SET version=version+1 WHERE customer_id=$1', [current.customer_id]);
 if (input.kind === 'personal') await event(c, actor, current.customer_id, current.version + 1, 'crm.customer.updated');
 return { status: 'appended', customerId: current.customer_id };
}
async function event(c: PoolClient, actor: LeadActor, id: string, version: number, type: string) {
 await c.query('INSERT INTO identity.outbox(event_type,user_id,product_id,revision,customer_id,payload) VALUES($1,$2,$3,$4,$5,$6)', [type, actor.userId, 'crm', version, id, JSON.stringify({ customerId: id, version })]);
}
/** Caller owns authorization, advisory serialization, idempotency and the transaction. */
export async function importWorkbookIn(c: PoolClient, actor: LeadActor, input: WorkbookImportRequest): Promise<Result<WorkbookImportReceipt>> {
 const batchId = randomUUID();
 await c.query('INSERT INTO crm_import_batches(batch_id,actor_id,source,source_detail,mapping) VALUES($1,$2,$3,$4,$5)', [batchId, actor.userId, input.source, input.sourceDetail, JSON.stringify({ format: 'workbook', kind: input.kind })]);
 const receipts = new Array<WorkbookReceiptRow>(input.rows.length), blocked = new Set<string>();
 // Customers are resolved first even when an API request interleaves entity rows.
 for (const entity of ['customer', 'contact'] as const) for (const [index, row] of input.rows.entries()) {
  if (row.entity !== entity) continue;
  const issue = workbookRowIssue(row);
  const outcome = issue ? { status: 'invalid' as const, message: issue } : entity === 'customer' ? await importCustomer(c, actor, input, row) : await importContact(c, actor, input, row, blocked);
  if (entity === 'customer' && !['created', 'duplicate'].includes(outcome.status)) blocked.add(row.sourceRef.trim());
  const receipt: WorkbookReceiptRow = { rowId: randomUUID(), index, entity, sheetName: row.sheetName, rowNumber: row.rowNumber, ...outcome };
  await c.query('INSERT INTO crm_import_rows(row_id,batch_id,row_index,customer_key,raw_row,customer_id,status) VALUES($1,$2,$3,$4,$5,$6,$7)', [receipt.rowId, batchId, index, row.sourceRef, JSON.stringify({ input: row, rawRow: row.rawRow, entity, sheetName: row.sheetName, rowNumber: row.rowNumber }), outcome.customerId ?? null, outcome.status]);
  receipts[index] = receipt;
 }
 return success({ batchId, rows: receipts });
}
