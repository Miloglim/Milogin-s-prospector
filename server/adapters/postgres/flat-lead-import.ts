import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { importRowIssue, type ImportRequest, type ImportReceipt, type ImportReceiptRow } from '../../core/leads';
import type { LeadActor } from './lead-repository';
import { canDeleteContact, loadContactIn } from './contact-assignment-repository';

const optional = (value: string | undefined): string | null => value?.trim() || null;
/** The caller owns authorization, advisory locking, idempotency and the transaction. */
export async function importFlatLeadsIn(c: PoolClient, actor: LeadActor, input: ImportRequest): Promise<ImportReceipt> {
  const personal = input.kind === 'personal';
  const batchId = randomUUID();
  await c.query('INSERT INTO crm_import_batches(batch_id,actor_id,source,source_detail,mapping) VALUES($1,$2,$3,$4,$5)', [batchId,actor.userId,input.source,input.sourceDetail,JSON.stringify(input.mapping ?? {})]);
  const rows: ImportReceiptRow[] = [];
  for (const [index, original] of input.rows.entries()) {
    const row = {...original, customerKey:original.customerKey.trim(), companyName:original.companyName.trim(),email:original.email.trim().toLowerCase()};
    const rowId = randomUUID();
    let status: ImportReceiptRow['status'] = 'created';
    let message = importRowIssue(row);
    let customerId: string | undefined;
    if (message) status = 'invalid';
    else {
      const existing = await c.query('SELECT * FROM crm_customers WHERE source=$1 AND customer_key=$2 FOR UPDATE',[input.source,row.customerKey]);
      let parent = existing.rows[0];
      if (!parent && input.companyMatching) {
        // Match within the actor's authorized origin. A company name never grants contact access.
        const matches = await c.query(`SELECT cu.* FROM crm_customers cu JOIN companies co ON co.id=cu.company_id
          WHERE lower(btrim(co.name))=lower(btrim($1)) AND co.crm_deleted_at IS NULL
          AND cu.origin=$2 AND ($3::boolean AND cu.owner_user_id=$4::uuid OR NOT $3::boolean AND cu.owner_user_id IS NULL AND cu.state IN ('draft','published'))
          ORDER BY cu.customer_id FOR UPDATE OF cu`,[row.companyName,input.kind,personal,actor.userId]);
        if (matches.rows.length > 1) { status='restricted_conflict'; message='存在多条同名公司，请核对公司资料'; }
        else parent=matches.rows[0];
      }
      const contact = row.email ? await c.query('SELECT ct.*,cc.customer_id FROM contacts ct LEFT JOIN crm_customer_contacts cc ON cc.contact_id=ct.id WHERE ct.email=$1',[row.email]) : {rows:[]};
      const activeContact = contact.rows.find(item => item.crm_deleted_at === null);
      const deletedContact = contact.rows.find(item => item.crm_deleted_at !== null);
      if (activeContact && (!parent || activeContact.customer_id!==parent.customer_id)) status='restricted_conflict';
      const restorableDeleted = deletedContact
        ? await loadContactIn(c, { contactId: deletedContact.id, customerId: deletedContact.customer_id }, true, true)
        : undefined;
      if (deletedContact && (!restorableDeleted || !canDeleteContact(actor, restorableDeleted))) {
        status='restricted_conflict'; message='该邮箱属于已删除联系人，请使用原公司资料恢复';
      }
      if (deletedContact && restorableDeleted && canDeleteContact(actor, restorableDeleted) && !parent) {
        parent=(await c.query('SELECT * FROM crm_customers WHERE customer_id=$1 FOR UPDATE',[deletedContact.customer_id])).rows[0];
        if (parent) row.companyName=restorableDeleted.companyName;
      }
      if (parent && (parent.origin!==input.kind || (personal ? parent.owner_user_id!==actor.userId || parent.state!=='owned' : parent.owner_user_id!==null || !['draft',...(input.companyMatching?['published']:[])].includes(parent.state)))) status='restricted_conflict';
      if (deletedContact && parent && parent.customer_id !== deletedContact.customer_id) {
        status='restricted_conflict'; message='该邮箱属于已删除联系人，请使用原公司资料恢复';
      }
      if (status==='created') {
        let companyId: number | undefined = parent?.company_id;
        const companies = await c.query(`SELECT co.* FROM companies co WHERE co.crm_deleted_at IS NULL AND
          ${companyId ? 'co.id=$1' : `lower(btrim(co.name))=lower(btrim($1)) AND (
            co.crm_created_by=$2::uuid AND NOT EXISTS(SELECT 1 FROM crm_customers cu WHERE cu.company_id=co.id) AND NOT EXISTS(SELECT 1 FROM contacts ct WHERE ct.company_id=co.id)
            OR EXISTS(SELECT 1 FROM crm_customers cu WHERE cu.company_id=co.id AND cu.origin=$3 AND ($4::boolean AND cu.owner_user_id=$2::uuid OR NOT $4::boolean)))`}
          ORDER BY co.id FOR UPDATE`,companyId?[companyId]:[row.companyName,actor.userId,input.kind,personal]);
        const company = companies.rows[0];
        const fields = {country:optional(row.country),customer_type:optional(row.customerType),industry:optional(row.businessType),domain:optional(row.website)};
        const conflict = company && Object.entries(fields).find(([key,value])=>value && company[key] && company[key]!==value);
        if (parent && !company || company && company.name.trim().toLowerCase()!==row.companyName.toLowerCase() || conflict || companies.rows.length>1) {
          status='restricted_conflict'; message='同一公司的国家、客户类型、业务类型或网站不一致，请核对';
        } else {
          if (company) {
            companyId=company.id;
            await c.query("UPDATE companies SET country=COALESCE(NULLIF(btrim(country),''),$2),customer_type=COALESCE(customer_type,$3),industry=COALESCE(NULLIF(btrim(industry),''),$4),domain=COALESCE(NULLIF(btrim(domain),''),$5),updated_at=now() WHERE id=$1",[companyId,...Object.values(fields)]);
          } else {
            companyId=(await c.query('INSERT INTO companies(name,country,customer_type,industry,domain) VALUES($1,$2,$3,$4,$5) RETURNING id',[row.companyName,...Object.values(fields)])).rows[0].id;
          }
          customerId=parent?.customer_id ?? randomUUID();
          const newCustomer = !parent;
          if (!parent) {
            await c.query('INSERT INTO crm_customers(customer_id,company_id,source,customer_key,source_detail,created_by,origin,state,owner_user_id,business_type) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[customerId,companyId,input.source,row.customerKey,input.sourceDetail,actor.userId,input.kind,personal?'owned':'draft',personal?actor.userId:null,optional(row.businessType)]);
          }
          // Email-less records are duplicates only when all supplied contact details match.
          const values=[optional(row.firstName??row.name),optional(row.lastName),optional(row.title),optional(row.phone),optional(row.whatsapp),optional(row.linkedinUrl),optional(row.sourceLevel1),optional(row.sourceLevel2)];
          const identical = !row.email && await c.query(`SELECT ct.id FROM contacts ct JOIN crm_customer_contacts cc ON cc.contact_id=ct.id
            WHERE cc.customer_id=$1 AND ct.email IS NULL AND ct.crm_deleted_at IS NULL
            AND ct.first_name IS NOT DISTINCT FROM $2 AND ct.last_name IS NOT DISTINCT FROM $3 AND ct.title IS NOT DISTINCT FROM $4
            AND ct.phone IS NOT DISTINCT FROM $5 AND ct.whatsapp IS NOT DISTINCT FROM $6 AND ct.linkedin IS NOT DISTINCT FROM $7
            AND ct.source_level1 IS NOT DISTINCT FROM $8 AND ct.source_level2 IS NOT DISTINCT FROM $9`,[customerId,...values]);
          if (activeContact || identical && identical.rows.length) status='duplicate';
          else {
            let contactId: number | undefined;
            let contactVersion: number | undefined;
            if (deletedContact) {
              if (!restorableDeleted) {
                status='restricted_conflict'; message='该邮箱属于已删除联系人，请使用原公司资料恢复';
              } else {
                const restored=await c.query(`UPDATE contacts SET company_id=$2,
                  first_name=COALESCE($3,first_name),last_name=COALESCE($4,last_name),title=COALESCE($5,title),
                  phone=COALESCE($6,phone),whatsapp=COALESCE($7,whatsapp),linkedin=COALESCE($8,linkedin),
                  source_level1=COALESCE($9,source_level1),source_level2=COALESCE($10,source_level2),country=COALESCE($11,country),
                  language=COALESCE($12,language),client_type=COALESCE($13,client_type),stage=COALESCE($14,stage),status=COALESCE($15,status),
                  tags=CASE WHEN $16::jsonb='[]'::jsonb THEN tags ELSE $16::jsonb END,
                  crm_deleted_at=NULL,crm_deleted_by=NULL,crm_contact_version=crm_contact_version+1,updated_at=clock_timestamp()
                  WHERE id=$1 AND crm_deleted_at IS NOT NULL RETURNING crm_contact_version`,[deletedContact.id,companyId,...values,optional(row.country),optional(row.language),optional(row.clientType),optional(row.stage),optional(row.status),JSON.stringify(row.tags??[])]);
                if (!restored.rows.length) {
                  status='restricted_conflict'; message='联系人恢复状态已变化，请刷新后重试';
                } else {
                  contactId=deletedContact.id;contactVersion=restored.rows[0].crm_contact_version;
                  await c.query('INSERT INTO crm_customer_contacts(customer_id,contact_id) VALUES($1,$2) ON CONFLICT(contact_id) DO NOTHING',[customerId,contactId]);
                }
              }
            } else {
              const created=await c.query('INSERT INTO contacts(email,company_id,first_name,last_name,title,phone,whatsapp,linkedin,source_level1,source_level2,country,language,client_type,stage,status,tags,source,source_detail) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18) RETURNING id,crm_contact_version',[row.email||null,companyId,...values,optional(row.country),optional(row.language),optional(row.clientType),row.stage??'cold',row.status??'',JSON.stringify(row.tags??[]),input.source,input.sourceDetail]);
              contactId=created.rows[0].id;contactVersion=created.rows[0].crm_contact_version;
              await c.query('INSERT INTO crm_customer_contacts(customer_id,contact_id) VALUES($1,$2)',[customerId,contactId]);
            }
            if (status === 'created') {
              const version=(await c.query('SELECT version FROM crm_customers WHERE customer_id=$1',[customerId])).rows[0].version;
              if (!contactId || !contactVersion) {
                status='restricted_conflict'; message='联系人恢复结果不完整，请刷新后重试';
              } else {
                await c.query('INSERT INTO identity.outbox(event_type,user_id,product_id,revision,customer_id,payload) VALUES($1,$2,$3,$4,$5,$6)',[newCustomer?'crm.customer.created':deletedContact?'crm.contact.updated':'crm.customer.updated',actor.userId,'crm',deletedContact?contactVersion:version,customerId,JSON.stringify({customerId,...(deletedContact?{contactId,version:contactVersion}:{version}),companyName:row.companyName})]);
              }
            }
          }
        }
      }
    }
    await c.query('INSERT INTO crm_import_rows(row_id,batch_id,row_index,customer_key,raw_row,customer_id,status) VALUES($1,$2,$3,$4,$5,$6,$7)',[rowId,batchId,index,row.customerKey,JSON.stringify({input:row,rawRow:row.rawRow??original}),customerId??null,status]);
    rows.push({rowId,index,status,...(customerId?{customerId}:{}),...(message?{message}:status==='restricted_conflict'?{message:'需核实来源或客户归属'}:{})});
  }
  return {batchId,version:1,rows};
}
