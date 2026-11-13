import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { failure, success, type Result } from '../../core/crm';
import {
  assessLeadIngress,
  classifyCompanyCandidates,
  LEAD_INGRESS_LIMITS,
  normalizedLeadIngressKeys,
  type LeadIngressAction,
  type LeadIngressApplication,
  type LeadIngressAssessment,
  type LeadIngressCandidateDTO,
  type LeadIngressCandidateSnapshot,
  type LeadIngressDecisionDTO,
  type LeadIngressInput,
  type LeadIngressResolutionCommand,
  type LeadIngressResolutionReceipt,
} from '../../core/lead-ingress';
import type { LeadActor } from './lead-repository';
import { canDeleteContact, loadContactIn } from './contact-assignment-repository';
import { normalizeSourceDate } from '../../core/customer-import';
import { migrateLeadMatchSchema } from './lead-match-schema';

type CandidateRow = {
  contact_id?: number | null;
  customer_id?: string | null;
  company_id: number;
  company_name: string;
  domain: string | null;
  country: string | null;
  contact_name: string | null;
  contact_version?: number | null;
  origin: string | null;
  owner_user_id: string | null;
  customer_state: string | null;
  created_by: string | null;
  company_created_by: string | null;
  deleted_at: string | null;
  company_deleted_at: string | null;
  active_assignment_status: string | null;
  shared: boolean;
};
type DecisionRow = {
  decision_id: string;
  actor_id: string;
  ingress_source: LeadIngressInput['source'];
  idempotency_key: string;
  request_digest: string;
  status: LeadIngressDecisionDTO['status'];
  conflict_level: LeadIngressDecisionDTO['level'];
  action: LeadIngressAction | null;
  message: string;
  original_values: LeadIngressInput;
  normalized_email: string;
  normalized_domain: string;
  normalized_company: string;
  normalized_country: string;
  candidate_contact_ids: number[];
  candidate_customer_ids: string[];
  candidate_company_ids: number[];
  candidate_scores: string[];
  candidate_levels: LeadIngressDecisionDTO['level'][];
  selected_contact_id: number | null;
  selected_customer_id: string | null;
  selected_company_id: number | null;
  version: number;
  resolution_key: string | null;
  resolution_digest: string | null;
  resolution_response: string | { customerId: string; companyId: number; contactIds: number[] } | null;
  created_at: Date;
  updated_at: Date;
  resolved_at: Date | null;
};

const globalActor = (actor: LeadActor) => actor.roles.includes('admin') && ['shared','summary'].includes(actor.scope) && actor.capabilities.includes('leads.read.all');
const operationsManager = (actor: LeadActor) => actor.roles.includes('operations') && ['shared','summary'].includes(actor.scope) && actor.capabilities.includes('leads.assign');
const contactLookupToken = (name: string): string => name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, '').slice(0, 4);
const text = (value: string | null | undefined) => value?.trim() || null;

function candidateVisible(actor: LeadActor, row: CandidateRow): boolean {
  if (globalActor(actor)) return true;
  if (!row.customer_id) return actor.capabilities.includes('leads.develop') && row.company_created_by === actor.userId;
  if (operationsManager(actor) && row.origin === 'operations') return true;
  return actor.capabilities.includes('leads.develop') && row.origin === 'personal' && row.owner_user_id === actor.userId
    || actor.capabilities.includes('leads.develop') && row.shared;
}

function candidateRestorable(actor: LeadActor, row: CandidateRow): boolean {
  if (!row.deleted_at || row.origin === null || row.company_deleted_at) return false;
  if (row.active_assignment_status === 'pending') return false;
  if (row.active_assignment_status === 'pending_transfer') return operationsManager(actor) && row.origin === 'operations';
  return operationsManager(actor) && row.origin === 'operations'
    || actor.capabilities.includes('leads.develop') && row.origin === 'personal' && row.owner_user_id === actor.userId;
}

function snapshot(actor: LeadActor, row: CandidateRow, level: LeadIngressCandidateSnapshot['level'], score: number): LeadIngressCandidateSnapshot {
  return {
    contactId: row.contact_id ?? undefined,
    customerId: row.customer_id ?? undefined,
    companyId: row.company_id,
    contactName: row.contact_name,
    companyName: row.company_name,
    domain: row.domain,
    country: row.country,
    origin: row.origin,
    ownerUserId: row.owner_user_id,
    createdBy: row.created_by,
    customerState: row.customer_state,
    softDeleted: !!row.deleted_at,
    contactVersion: row.contact_version ?? undefined,
    canResolve: candidateVisible(actor, row),
    restorable: candidateRestorable(actor, row),
    level,
    score,
  };
}

const CANDIDATE_SELECT = `
  ct.id AS contact_id,
  c.customer_id,
  co.id AS company_id,
  co.name AS company_name,
  co.domain,
  co.country,
  COALESCE(NULLIF(btrim(concat_ws(' ',ct.first_name,ct.last_name)),''),NULLIF(btrim(ct.email),'')) AS contact_name,
  ct.crm_contact_version AS contact_version,
  c.origin,
  COALESCE((SELECT own.owner_user_id FROM crm_contact_ownership own WHERE own.contact_id=ct.id AND own.customer_id=c.customer_id AND own.ended_at IS NULL ORDER BY own.started_at DESC,own.ownership_id DESC LIMIT 1),c.owner_user_id) AS owner_user_id,
  c.state AS customer_state,
  c.created_by,
  co.crm_created_by AS company_created_by,
  CASE WHEN ct.crm_deleted_at IS NULL THEN NULL ELSE ct.crm_deleted_at::text END AS deleted_at,
  CASE WHEN co.crm_deleted_at IS NULL THEN NULL ELSE co.crm_deleted_at::text END AS company_deleted_at,
  (SELECT ar.status FROM crm_contact_assignment_requests ar WHERE ar.contact_id=ct.id AND ar.customer_id=c.customer_id AND ar.status IN ('pending','accepted','pending_transfer') ORDER BY ar.created_at DESC LIMIT 1) AS active_assignment_status,
  EXISTS(SELECT 1 FROM crm_contact_shares sh WHERE sh.contact_id=ct.id AND sh.customer_id=c.customer_id AND sh.target_user_id=$1::uuid AND sh.status='accepted') AS shared
`;

async function emailCandidates(c: PoolClient, actor: LeadActor, email: string, kind: LeadIngressInput['kind']): Promise<LeadIngressCandidateSnapshot[]> {
  if (!email) return [];
  const rows = await c.query<CandidateRow>(`SELECT ${CANDIDATE_SELECT}
    FROM contacts ct
    JOIN crm_customer_contacts cc ON cc.contact_id=ct.id
    JOIN crm_customers c ON c.customer_id=cc.customer_id
    JOIN companies co ON co.id=c.company_id
    WHERE lower(btrim(ct.email))=$2
      AND (($3='operations' AND c.origin='operations') OR ($3='personal' AND c.origin='personal' AND c.owner_user_id=$1))
    FOR SHARE OF ct,c`, [actor.userId, email, kind]);
  return rows.rows.map(row => snapshot(actor, row, 'exact_email', 1));
}

async function companyCandidates(c: PoolClient, actor: LeadActor, input: LeadIngressInput): Promise<LeadIngressCandidateSnapshot[]> {
  const keys = normalizedLeadIngressKeys(input);
  const token = contactLookupToken(input.company.name);
  const rows = await c.query<CandidateRow>(`SELECT ${CANDIDATE_SELECT}
    FROM companies co
    LEFT JOIN crm_customers c ON c.company_id=co.id
    LEFT JOIN crm_customer_contacts cc ON cc.customer_id=c.customer_id
    LEFT JOIN contacts ct ON ct.id=cc.contact_id
    WHERE co.crm_deleted_at IS NULL AND (
      ($2::text<>'' AND lower(btrim(co.domain)) LIKE '%'||split_part($2::text,'.',1)||'%')
      OR lower(btrim(co.name))=lower(btrim($3))
      OR ($4::text<>'' AND lower(btrim(co.name)) LIKE '%'||$4::text||'%')
    ) AND (($5='operations' AND c.origin='operations') OR ($5='personal' AND c.origin='personal' AND c.owner_user_id=$1))
    ORDER BY co.id,ct.id
    LIMIT 200
    FOR SHARE OF co`, [actor.userId, keys.domain, input.company.name, token, input.kind]);
  const snapshots = rows.rows.map(row => snapshot(actor, row, 'none', 0));
  return classifyCompanyCandidates(input.company, snapshots.map(row => {
    return {
      companyId: row.companyId, name: row.companyName, domain: row.domain, country: row.country,
      contactName: row.contactName, customerId: row.customerId, contactId: row.contactId,
      softDeleted: row.softDeleted, contactVersion: row.contactVersion, canResolve: row.canResolve,
      restorable: row.restorable, origin: row.origin, ownerUserId: row.ownerUserId,
      createdBy: row.createdBy, customerState: row.customerState,
    };
  }));
}

async function candidatesIn(c: PoolClient, actor: LeadActor, input: LeadIngressInput): Promise<LeadIngressCandidateSnapshot[]> {
  const emails = [...new Set(input.contacts.map(contact => (contact.email ?? '').trim().toLowerCase()).filter(Boolean))];
  const exact: LeadIngressCandidateSnapshot[] = [];
  for (const email of emails) exact.push(...await emailCandidates(c, actor, email, input.kind));
  const companies = input.target?.customerId ? [] : await companyCandidates(c, actor, input);
  return [...exact, ...companies];
}

function requestDigest(input: LeadIngressInput): string {
  return JSON.stringify(input);
}

function decisionBase(row: DecisionRow): LeadIngressDecisionDTO {
  return {
    decisionId: row.decision_id,
    ingressSource: row.ingress_source,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    level: row.conflict_level,
    action: row.action,
    suggestedActions: [],
    candidates: [],
    version: row.version,
    message: row.message,
    createdAt: row.created_at.toISOString(),
    resolvedAt: row.resolved_at?.toISOString() ?? null,
  };
}

function candidateDTO(candidate: LeadIngressCandidateSnapshot): LeadIngressCandidateDTO {
  return {
    contactId: candidate.contactId,
    customerId: candidate.customerId,
    companyId: candidate.companyId,
    label: candidate.companyName,
    domain: candidate.domain ?? null,
    country: candidate.country ?? null,
    score: candidate.score ?? 0,
    level: candidate.level ?? 'none',
  };
}

function decisionDTO(row: DecisionRow, assessment?: LeadIngressAssessment): LeadIngressDecisionDTO {
  const base = decisionBase(row);
  const candidates = assessment?.candidates ?? [];
  return {
    ...base,
    action: row.action,
    suggestedActions: assessment?.suggestedActions ?? [],
    candidates: candidates.map(candidateDTO),
    ...(candidates[0] ? { candidate: candidateDTO(candidates[0]) } : {}),
  };
}

async function decisionRow(c: PoolClient, actor: LeadActor, decisionId: string, lock = false): Promise<DecisionRow | undefined> {
  return (await c.query<DecisionRow>('SELECT * FROM crm_lead_match_decisions WHERE decision_id=$1 AND actor_id=$2' + (lock ? ' FOR UPDATE' : ''), [decisionId, actor.userId])).rows[0];
}

async function saveAssessment(c: PoolClient, actor: LeadActor, input: LeadIngressInput, assessment: LeadIngressAssessment): Promise<Result<{ row: DecisionRow; assessment: LeadIngressAssessment }>> {
  const keys = normalizedLeadIngressKeys(input);
  const candidates = assessment.candidates.slice(0, LEAD_INGRESS_LIMITS.candidates);
  const selected = assessment.candidate;
  const digest = requestDigest(input);
  const existing = (await c.query<DecisionRow>('SELECT * FROM crm_lead_match_decisions WHERE actor_id=$1 AND ingress_source=$2 AND idempotency_key=$3 FOR UPDATE', [actor.userId, input.source, input.idempotencyKey])).rows[0];
  if (existing) {
    if (existing.request_digest !== digest) return failure('CONFLICT', '幂等键已用于不同线索请求');
    return success({ row: existing, assessment });
  }
  const row = (await c.query<DecisionRow>(`INSERT INTO crm_lead_match_decisions(
    actor_id,ingress_source,idempotency_key,request_digest,status,conflict_level,action,message,original_values,
    normalized_email,normalized_domain,normalized_company,normalized_country,
    candidate_contact_ids,candidate_customer_ids,candidate_company_ids,candidate_scores,candidate_levels,
    selected_contact_id,selected_customer_id,selected_company_id
  ) VALUES($1,$2,$3,$4,$5,$6,NULL,$7,$8::jsonb,$9,$10,$11,$12,$13::int[],$14::uuid[],$15::int[],$16::numeric[],$17::text[],$18,$19,$20)
  RETURNING *`, [
    actor.userId,input.source,input.idempotencyKey,digest,
    assessment.status === 'clear' ? 'allowed' : assessment.status === 'restore' ? 'needs_resolution' : assessment.status,
    assessment.level,assessment.message,JSON.stringify(input),keys.email,keys.domain,keys.company,keys.country,
    candidates.map(item => item.contactId ?? null).filter((value): value is number => value !== undefined),
    candidates.map(item => item.customerId ?? null).filter((value): value is string => value !== null),
    candidates.map(item => item.companyId),candidates.map(item => item.score ?? 0),candidates.map(item => item.level ?? 'none'),
    selected?.contactId ?? null,selected?.customerId ?? null,selected?.companyId ?? null,
  ])).rows[0]!;
  return success({ row, assessment });
}

async function eventIn(c: PoolClient, actor: LeadActor, customerId: string, version: number, type: string, contactId?: number) {
  await c.query('INSERT INTO public.identity_outbox(event_type,user_id,product_id,revision,customer_id,payload) VALUES($1,$2,\'crm\',$3,$4,$5)', [
    type, actor.userId, version, customerId, JSON.stringify({ customerId, version, ...(contactId ? { contactId } : {}) }),
  ]);
}

async function createCustomerIn(c: PoolClient, actor: LeadActor, input: LeadIngressInput, companyId: number): Promise<string | undefined> {
  const customerId = randomUUID();
  const inserted = await c.query(`INSERT INTO crm_customers(
    customer_id,company_id,source,customer_key,source_detail,created_by,origin,state,owner_user_id,business_type,development_restriction,source_created_at
  ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING RETURNING customer_id`, [
    customerId, companyId, input.sourceChannel, input.customerKey || customerId, input.sourceDetail, actor.userId, input.kind,
    input.kind === 'personal' ? 'owned' : 'draft', input.kind === 'personal' ? actor.userId : null,
    text(input.company.businessType),text(input.profile?.developmentRestriction),
    input.profile?.sourceCreatedAt ? normalizeSourceDate(input.profile.sourceCreatedAt) : null,
  ]);
  return inserted.rows[0]?.customer_id;
}

async function appendContactsIn(c: PoolClient, actor: LeadActor, input: LeadIngressInput, companyId: number, customerId: string): Promise<{ ids: number[]; createdIds: number[] }> {
  const ids: number[] = [];
  const createdIds: number[] = [];
  for (const contact of input.contacts) {
    const email = (contact.email ?? '').trim().toLowerCase() || null;
    if (!email && input.target?.customerId) {
      const duplicate = await c.query(`SELECT ct.id FROM contacts ct JOIN crm_customer_contacts cc ON cc.contact_id=ct.id
        WHERE cc.customer_id=$1 AND ct.crm_deleted_at IS NULL AND ct.email IS NULL
          AND ct.first_name IS NOT DISTINCT FROM $2 AND ct.last_name IS NOT DISTINCT FROM $3
          AND ct.title IS NOT DISTINCT FROM $4 AND ct.phone IS NOT DISTINCT FROM $5
          AND ct.whatsapp IS NOT DISTINCT FROM $6 AND ct.linkedin IS NOT DISTINCT FROM $7
        LIMIT 1`, [input.target.customerId,text(contact.firstName ?? contact.name),text(contact.lastName),text(contact.title),text(contact.phone),text(contact.whatsapp),text(contact.linkedinUrl)]);
      if (duplicate.rows.length) { ids.push(Number(duplicate.rows[0].id)); continue; }
    }
    const created = await c.query(`INSERT INTO contacts(
      email,company_id,first_name,last_name,title,phone,whatsapp,linkedin,country,language,client_type,
      source_level1,source_level2,stage,status,tags,extra,source,source_detail
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18,$19)
    RETURNING id`, [
      email, companyId, text(contact.firstName ?? contact.name), text(contact.lastName), text(contact.title),
      text(contact.phone), text(contact.whatsapp), text(contact.linkedinUrl), text(contact.country), text(contact.language),
      text(contact.clientType), text(contact.sourceLevel1), text(contact.sourceLevel2), text(contact.stage) ?? 'cold',
      text(contact.status) ?? '', JSON.stringify(contact.tags ?? []), JSON.stringify(contact.extra ?? {}), input.sourceChannel, input.sourceDetail,
    ]);
    const contactId = Number(created.rows[0].id);
    await c.query('INSERT INTO crm_customer_contacts(customer_id,contact_id) VALUES($1,$2)', [customerId, contactId]);
    ids.push(contactId); createdIds.push(contactId);
  }
  return { ids, createdIds };
}

async function restoreContactIn(c: PoolClient, actor: LeadActor, input: LeadIngressInput, candidate: LeadIngressCandidateSnapshot): Promise<Result<{ contactId: number; customerId: string; companyId: number }>> {
  if (!candidate.contactId || !candidate.customerId) return failure('CONFLICT', '可恢复联系人已变化');
  const existing = await loadContactIn(c, { contactId: candidate.contactId, customerId: candidate.customerId }, true, true);
  const state=(await c.query('SELECT crm_deleted_at FROM contacts WHERE id=$1',[candidate.contactId])).rows[0];
  if (!existing || !state?.crm_deleted_at || !canDeleteContact(actor, existing)) return failure('CONFLICT', '原联系人不可恢复，请核实删除权限或归属');
  const contact = input.contacts[0] ?? {};
  const restored = await c.query(`UPDATE contacts SET
    first_name=COALESCE($2,first_name),last_name=COALESCE($3,last_name),title=COALESCE($4,title),phone=COALESCE($5,phone),
    whatsapp=COALESCE($6,whatsapp),linkedin=COALESCE($7,linkedin),country=COALESCE($8,country),language=COALESCE($9,language),
    client_type=COALESCE($10,client_type),source_level1=COALESCE($11,source_level1),source_level2=COALESCE($12,source_level2),
    stage=COALESCE($13,stage),status=COALESCE($14,status),tags=CASE WHEN $15::jsonb='[]'::jsonb THEN tags ELSE $15::jsonb END,
    extra=CASE WHEN $16::jsonb='{}'::jsonb THEN extra ELSE COALESCE(extra,'{}'::jsonb)||$16::jsonb END,
    crm_deleted_at=NULL,crm_deleted_by=NULL,crm_contact_version=crm_contact_version+1,updated_at=clock_timestamp()
    WHERE id=$1 AND crm_deleted_at IS NOT NULL RETURNING id,crm_contact_version`, [
    candidate.contactId,text(contact.firstName ?? contact.name),text(contact.lastName),text(contact.title),text(contact.phone),
    text(contact.whatsapp),text(contact.linkedinUrl),text(contact.country),text(contact.language),text(contact.clientType),
    text(contact.sourceLevel1),text(contact.sourceLevel2),text(contact.stage),text(contact.status),JSON.stringify(contact.tags ?? []),JSON.stringify(contact.extra ?? {}),
  ]);
  if (!restored.rows.length) return failure('CONFLICT', '联系人恢复状态已变化');
  await eventIn(c, actor, candidate.customerId, restored.rows[0].crm_contact_version, 'crm.contact.updated', candidate.contactId);
  return success({ contactId: candidate.contactId, customerId: candidate.customerId, companyId: existing.companyId });
}

function customerAttachable(actor: LeadActor, input: LeadIngressInput, candidate?: LeadIngressCandidateSnapshot): boolean {
  if (!candidate?.customerId) return false;
  if (input.kind === 'personal') return candidate.origin === 'personal' && candidate.ownerUserId === actor.userId;
  return candidate.origin === 'operations' && !candidate.ownerUserId && ['draft','published'].includes(candidate.customerState ?? '');
}

/** Materialization is shared by clear ingress and terminal conflict resolution. */
export async function materializeLeadIngressIn(
  c: PoolClient,
  actor: LeadActor,
  input: LeadIngressInput,
  action: LeadIngressAction,
  candidate?: LeadIngressCandidateSnapshot,
): Promise<Result<LeadIngressApplication>> {
  if (action === 'restore') {
    const restored = await restoreContactIn(c, actor, input, candidate!);
    if (!restored.ok) return restored;
    return success({ ...restored.data, contactIds: [restored.data.contactId], createdContactIds: [], createdCustomer: false, restoredContactIds: [restored.data.contactId] });
  }
  if (input.target?.customerId) {
    const target = (await c.query(`SELECT c.company_id,c.origin,c.owner_user_id,c.state,co.crm_deleted_at AS company_deleted_at
      FROM crm_customers c JOIN companies co ON co.id=c.company_id WHERE c.customer_id=$1 FOR UPDATE OF c`, [input.target.customerId])).rows[0];
    const editable = target && !target.company_deleted_at && target.origin === input.kind
      && (input.kind === 'personal'
        ? target.owner_user_id === actor.userId && target.state === 'owned'
        : operationsManager(actor) && !target.owner_user_id && ['draft','published'].includes(target.state));
    if (!editable) return failure('FORBIDDEN', '目标客户不在当前写入范围');
    const appended = await appendContactsIn(c, actor, input, target.company_id, input.target.customerId);
    if (appended.createdIds.length) {
      const version = Number((await c.query('UPDATE crm_customers SET version=version+1 WHERE customer_id=$1 RETURNING version', [input.target.customerId])).rows[0].version);
      await eventIn(c, actor, input.target.customerId, version, 'crm.customer.updated');
    }
    return success({ customerId: input.target.customerId, companyId: target.company_id, contactIds: appended.ids, createdContactIds: appended.createdIds, createdCustomer: false, restoredContactIds: [] });
  }
  let companyId: number;
  let customerId: string;
  let createdCustomer = false;
  if (action === 'attach_company') {
    if (!candidate) return failure('CONFLICT', '待关联公司已变化');
    companyId = candidate.companyId;
    const attached = customerAttachable(actor, input, candidate);
    if (attached) customerId = candidate.customerId!;
    else {
      const created = await createCustomerIn(c, actor, input, companyId);
      if (!created) return failure('CONFLICT', '同一来源客户已存在，请刷新后重试');
      customerId = created; createdCustomer = true;
    }
  } else {
    const company = await c.query('INSERT INTO companies(name,country,customer_type,industry,domain) VALUES($1,$2,$3,$4,$5) RETURNING id', [
      input.company.name.trim(),text(input.company.country),text(input.company.customerType),text(input.company.businessType),text(input.company.domain),
    ]);
    companyId = company.rows[0].id;
    const created = await createCustomerIn(c, actor, input, companyId);
    if (!created) return failure('CONFLICT', '同一来源客户已存在，请刷新后重试');
    customerId = created; createdCustomer = true;
  }
  const appended = await appendContactsIn(c, actor, input, companyId, customerId), contactIds = appended.ids;
  const currentVersion = Number((await c.query('SELECT version FROM crm_customers WHERE customer_id=$1 FOR UPDATE', [customerId])).rows[0]?.version ?? 1);
  if (createdCustomer) await eventIn(c, actor, customerId, currentVersion, 'crm.customer.created');
  else if (contactIds.length) {
    const version = Number((await c.query('UPDATE crm_customers SET version=version+1 WHERE customer_id=$1 RETURNING version', [customerId])).rows[0].version);
    await eventIn(c, actor, customerId, version, 'crm.customer.updated');
  }
  return success({ customerId, companyId, contactIds, createdContactIds: appended.createdIds, createdCustomer, restoredContactIds: [] });
}

export interface LeadIngressEvaluation {
  decision: LeadIngressDecisionDTO;
  assessment: LeadIngressAssessment;
  application?: LeadIngressApplication;
}

async function finalizeDecisionIn(
  c: PoolClient,
  row: DecisionRow,
  action: LeadIngressAction,
  idempotencyKey: string,
  resolutionDigest: string,
  application: LeadIngressApplication,
  assessment: LeadIngressAssessment,
): Promise<Result<LeadIngressResolutionReceipt>> {
  const response = { customerId: application.customerId, companyId: application.companyId, contactIds: application.contactIds };
  const updated = (await c.query<DecisionRow>(`UPDATE crm_lead_match_decisions SET
    status='resolved',action=$2,version=version+1,resolution_key=$3,resolution_digest=$4,resolution_response=$5::jsonb,
    updated_at=clock_timestamp(),resolved_at=clock_timestamp()
    WHERE decision_id=$1 RETURNING *`, [row.decision_id, action, idempotencyKey, resolutionDigest, JSON.stringify(response)])).rows[0]!;
  return success({ decision: decisionDTO(updated, { ...assessment, candidates: [], candidate: undefined, suggestedActions: [] }), ...response });
}

async function persistReferencesIn(c: PoolClient, actor: LeadActor, input: LeadIngressInput, application: LeadIngressApplication): Promise<Result<void>> {
  const refs = input.references;
  if (input.source !== 'workbook_import' || !refs?.sourceRef || !refs.entity) return success(undefined);
  const contactId = refs.entity === 'contact' ? application.contactIds[0] : null;
  if (refs.entity === 'contact' && !contactId) return failure('CONFLICT', '联系人来源映射缺少联系人');
  await c.query(`INSERT INTO crm_workbook_source_mappings(
    actor_id,source,origin,entity,source_ref,customer_ref,customer_id,contact_id
  ) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`, [
    actor.userId,input.sourceChannel,input.kind,refs.entity,refs.sourceRef,refs.customerRef ?? refs.sourceRef,
    application.customerId,contactId,
  ]);
  return success(undefined);
}

function persistedResolution(row: DecisionRow): { customerId: string; companyId: number; contactIds: number[] } | undefined {
  if (!row.resolution_response) return undefined;
  const value = typeof row.resolution_response === 'string' ? JSON.parse(row.resolution_response) : row.resolution_response;
  return value && typeof value === 'object' && typeof value.customerId === 'string' && Number.isSafeInteger(value.companyId) && Array.isArray(value.contactIds)
    ? value as { customerId: string; companyId: number; contactIds: number[] }
    : undefined;
}

async function resolutionCandidateIn(c: PoolClient, actor: LeadActor, row: DecisionRow, action: LeadIngressAction): Promise<Result<{ assessment: LeadIngressAssessment; candidate?: LeadIngressCandidateSnapshot }>> {
  const input = row.original_values;
  const assessment = assessLeadIngress(input, await candidatesIn(c, actor, input));
  if (assessment.status === 'restricted_conflict') return failure('CONFLICT', assessment.message);
  if (action === 'restore') {
    if (assessment.status !== 'restore' || assessment.candidate?.contactId !== row.selected_contact_id) return failure('CONFLICT', '可恢复联系人已变化，请刷新后重试');
    return success({ assessment, candidate: assessment.candidate });
  }
  if (assessment.status === 'duplicate' && assessment.level === 'exact_email') return failure('CONFLICT', assessment.message);
  if (action === 'attach_company') {
    const candidate = assessment.candidates.find(item => item.companyId === row.selected_company_id && item.canResolve);
    if (!candidate) return failure('CONFLICT', '待关联公司已变化，请刷新后重试');
    return success({ assessment, candidate });
  }
  return success({ assessment });
}

async function applyDecisionIn(
  c: PoolClient,
  actor: LeadActor,
  row: DecisionRow,
  action: LeadIngressAction,
  idempotencyKey: string,
): Promise<Result<LeadIngressResolutionReceipt>> {
  const fresh = await resolutionCandidateIn(c, actor, row, action);
  if (!fresh.ok) return fresh;
  if (!fresh.data.assessment.suggestedActions.includes(action) && action !== 'create_new') return failure('CONFLICT', '当前冲突不支持所选处理方式');
  const applied = await materializeLeadIngressIn(c, actor, row.original_values, action, fresh.data.candidate);
  if (!applied.ok) return applied;
  const mapped = await persistReferencesIn(c, actor, row.original_values, applied.data);
  if (!mapped.ok) return mapped;
  return finalizeDecisionIn(c, row, action, idempotencyKey, JSON.stringify({ action, expectedVersion: row.version }), applied.data, fresh.data.assessment);
}

export async function evaluateLeadIngressIn(
  c: PoolClient,
  actor: LeadActor,
  input: LeadIngressInput,
  options: { autoRestore?: boolean } = {},
): Promise<Result<LeadIngressEvaluation>> {
  const migrated = await migrateLeadMatchSchema(c);
  if (!migrated.ok) return migrated;
  const found = await saveAssessment(c, actor, input, assessLeadIngress(input, await candidatesIn(c, actor, input)));
  if (!found.ok) return found;
  const { row, assessment } = found.data;
  if (row.status === 'resolved') {
    const persisted = persistedResolution(row);
    return persisted
      ? success({ decision: decisionDTO(row, { ...assessment, candidates: [], candidate: undefined, suggestedActions: [] }), assessment, application: { ...persisted, createdCustomer: false, restoredContactIds: [] } })
      : failure('CONFLICT', '冲突记录结果缺失');
  }
  if (options.autoRestore && assessment.status === 'restore') {
    const applied = await materializeLeadIngressIn(c, actor, input, 'restore', assessment.candidate);
    if (!applied.ok) return applied;
    const finalized = await finalizeDecisionIn(c, row, 'restore', `auto:${input.idempotencyKey}`, `auto:${input.idempotencyKey}`, applied.data, assessment);
    if (!finalized.ok) return finalized;
    return success({ decision: finalized.data.decision, assessment, application: applied.data });
  }
  return success({ decision: decisionDTO(row, assessment), assessment });
}

export async function resolveLeadIngressIn(c: PoolClient, actor: LeadActor, command: LeadIngressResolutionCommand): Promise<Result<LeadIngressResolutionReceipt>> {
  const row = await decisionRow(c, actor, command.decisionId, true);
  if (!row) return failure('NOT_FOUND', '冲突记录不存在');
  if (row.status === 'resolved') {
    const persisted = persistedResolution(row);
    const digest = JSON.stringify({ action: command.action, expectedVersion: command.expectedVersion });
    if (!persisted || row.resolution_key !== command.idempotencyKey || row.action !== command.action || row.resolution_digest !== digest) return failure('CONFLICT', '冲突已由其他操作处理');
    return success({ decision: decisionDTO(row, { status: 'clear', level: 'none', candidates: [], suggestedActions: [], message: row.message }), ...persisted });
  }
  if (row.version !== command.expectedVersion) return failure('CONFLICT', '冲突记录已变化，请刷新重试');
  return applyDecisionIn(c, actor, row, command.action, command.idempotencyKey);
}

export async function leadIngressDecisionIn(c: PoolClient, actor: LeadActor, source: LeadIngressInput['source'], idempotencyKey: string): Promise<Result<LeadIngressDecisionDTO>> {
  const row = (await c.query<DecisionRow>('SELECT * FROM crm_lead_match_decisions WHERE actor_id=$1 AND ingress_source=$2 AND idempotency_key=$3', [actor.userId, source, idempotencyKey])).rows[0];
  if (!row) return failure('NOT_FOUND', '冲突记录不存在');
  if (row.status !== 'needs_resolution') return success(decisionDTO(row, { status: 'clear', level: row.conflict_level, candidates: [], suggestedActions: [], message: row.message }));
  const assessment = assessLeadIngress(row.original_values, await candidatesIn(c, actor, row.original_values));
  return success(decisionDTO(row, assessment));
}
