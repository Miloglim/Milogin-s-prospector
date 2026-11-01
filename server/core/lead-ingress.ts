import { failure, success, type JsonObject, type Result } from './crm';
import { matchCompanyConflict, normalizeCompanyDomain, normalizeCompanyName, normalizeLeadEmail, type LeadConflictLevel } from './lead-conflict';

export const LEAD_INGRESS_ROUTES = { decision: '/api/crm/lead-ingress/decision', resolve: '/api/crm/lead-ingress/resolve' } as const;
export const LEAD_INGRESS_LIMITS = { contacts: 200, candidates: 5, text: 500, key: 160 } as const;
export const LEAD_INGRESS_SOURCES = ['manual','flat_import','workbook_import','agent_import','api_contact_update','soft_delete_recovery','migration_recovery'] as const;
export type LeadIngressSource = typeof LEAD_INGRESS_SOURCES[number];
export type LeadIngressKind = 'personal' | 'operations';
export type LeadIngressAction = 'create_new' | 'attach_company' | 'restore';
export type LeadIngressDecisionStatus = 'allowed' | 'duplicate' | 'restricted_conflict' | 'needs_resolution' | 'resolved';

export interface LeadIngressContactInput {
  email?: string | null; name?: string | null; firstName?: string | null; lastName?: string | null;
  title?: string | null; phone?: string | null; whatsapp?: string | null; linkedinUrl?: string | null;
  country?: string | null; language?: string | null; clientType?: string | null;
  sourceLevel1?: string | null; sourceLevel2?: string | null; stage?: string | null; status?: string | null;
  tags?: string[]; extra?: JsonObject;
}
export interface LeadIngressCompanyInput { name: string; domain?: string | null; country?: string | null; customerType?: string | null; businessType?: string | null; }
export interface LeadIngressTarget { customerId?: string; contactId?: number; companyId?: number; }
export interface LeadIngressInput {
  source: LeadIngressSource; sourceChannel: string; sourceDetail: string; kind: LeadIngressKind; idempotencyKey: string; customerKey: string;
  company: LeadIngressCompanyInput; contacts: LeadIngressContactInput[]; target?: LeadIngressTarget;
  checkCompany?: boolean;
  profile?: { developmentRestriction?: string | null; sourceCreatedAt?: string | null };
  references?: { sourceRef?: string; customerRef?: string; entity?: 'customer' | 'contact' };
}
export interface LeadIngressCandidateDTO {
  contactId?: number; customerId?: string; companyId: number; label: string; domain: string | null;
  country: string | null; score: number; level: LeadConflictLevel;
}
export interface LeadIngressDecisionDTO {
  decisionId: string; ingressSource: LeadIngressSource; idempotencyKey: string; status: LeadIngressDecisionStatus;
  level: LeadConflictLevel; action: LeadIngressAction | null; suggestedActions: LeadIngressAction[];
  candidate?: LeadIngressCandidateDTO; candidates: LeadIngressCandidateDTO[]; version: number; message: string;
  createdAt: string; resolvedAt: string | null;
}
export interface LeadIngressResolutionCommand { decisionId: string; action: LeadIngressAction; expectedVersion: number; idempotencyKey: string; }
export interface LeadIngressResolutionReceipt { decision: LeadIngressDecisionDTO; customerId: string; companyId: number; contactIds: number[]; }
export interface LeadIngressApplication { customerId: string; companyId: number; contactIds: number[]; createdContactIds?: number[]; createdCustomer: boolean; restoredContactIds: number[]; }
export interface LeadIngressDecisionQuery { source: LeadIngressSource; idempotencyKey: string; }

/** Internal candidate facts never leave the server unless canResolve is true. */
export interface LeadIngressCandidateSnapshot {
  contactId?: number; customerId?: string; companyId: number; contactName?: string | null; companyName: string;
  domain?: string | null; country?: string | null; origin?: string | null; ownerUserId?: string | null;
  createdBy?: string | null; customerState?: string | null; softDeleted?: boolean; contactVersion?: number;
  canResolve: boolean; restorable: boolean; level?: LeadConflictLevel; score?: number;
}
export interface LeadIngressAssessment {
  status: 'clear' | 'duplicate' | 'restricted_conflict' | 'needs_resolution' | 'restore';
  level: LeadConflictLevel; candidates: LeadIngressCandidateSnapshot[]; candidate?: LeadIngressCandidateSnapshot;
  suggestedActions: LeadIngressAction[]; message: string;
}
export interface LeadIngressRepository {
  resolveLeadIngress?(hash: string, input: LeadIngressResolutionCommand): Promise<Result<LeadIngressResolutionReceipt>>;
  leadIngressDecision?(hash: string, input: LeadIngressDecisionQuery): Promise<Result<LeadIngressDecisionDTO>>;
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number = LEAD_INGRESS_LIMITS.text, min = 1): value is string =>
  typeof value === 'string' && value.trim().length >= min && value.length <= max;

export function validateLeadIngressResolution(value: unknown): Result<LeadIngressResolutionCommand> {
  if (!record(value) || Object.keys(value).some(key => !['decisionId','action','expectedVersion','idempotencyKey'].includes(key))) return failure('INVALID_INPUT', '冲突处理参数无效');
  if (!text(value.decisionId, 64) || !UUID.test(value.decisionId)
    || !['create_new','attach_company','restore'].includes(String(value.action))
    || !Number.isSafeInteger(value.expectedVersion) || Number(value.expectedVersion) < 1
    || !text(value.idempotencyKey, LEAD_INGRESS_LIMITS.key)) return failure('INVALID_INPUT', '冲突处理参数无效');
  return success({ decisionId: value.decisionId, action: value.action as LeadIngressAction, expectedVersion: Number(value.expectedVersion), idempotencyKey: value.idempotencyKey });
}
export function validateLeadIngressDecisionQuery(source: unknown, idempotencyKey: unknown): Result<LeadIngressDecisionQuery> {
  if (!LEAD_INGRESS_SOURCES.includes(source as LeadIngressSource) || !text(idempotencyKey, LEAD_INGRESS_LIMITS.key)) return failure('INVALID_INPUT', '冲突记录参数无效');
  return success({ source: source as LeadIngressSource, idempotencyKey });
}

function sameTarget(input: LeadIngressInput, candidate: LeadIngressCandidateSnapshot): boolean {
  return (input.target?.contactId !== undefined && input.target.contactId === candidate.contactId)
    || (input.target?.contactId === undefined && input.target?.customerId !== undefined && input.target.customerId === candidate.customerId);
}

function accessibleByCompany(candidates: LeadIngressCandidateSnapshot[]): LeadIngressCandidateSnapshot[] {
  const byCompany = new Map<number, LeadIngressCandidateSnapshot>();
  for (const candidate of candidates) {
    const previous = byCompany.get(candidate.companyId);
    if (!previous || (candidate.level === 'exact_email' && previous.level !== 'exact_email')
      || (candidate.canResolve && !previous.canResolve) || (candidate.score ?? 0) > (previous.score ?? 0)) {
      byCompany.set(candidate.companyId, candidate);
    }
  }
  return [...byCompany.values()].sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
}

/** One rule set is shared by manual input, imports, Agent calls, updates and recovery. */
export function assessLeadIngress(input: LeadIngressInput, candidates: readonly LeadIngressCandidateSnapshot[]): LeadIngressAssessment {
  const exact = candidates.find(candidate => candidate.level === 'exact_email' && candidate.canResolve);
  const privateExact = candidates.find(candidate => candidate.level === 'exact_email' && !candidate.canResolve);
  if (exact) {
    if (exact.softDeleted && exact.restorable) {
      return { status: 'restore', level: 'exact_email', candidate: exact, candidates: [exact], suggestedActions: ['restore'], message: '邮箱属于已删除联系人，可恢复原记录' };
    }
    if (exact.softDeleted) {
      return { status: 'restricted_conflict', level: 'exact_email', candidates: [], suggestedActions: [], message: '邮箱属于不可恢复的已删除联系人，请核实删除权限或归属' };
    }
    if (sameTarget(input, exact)) {
      return { status: 'duplicate', level: 'exact_email', candidate: exact, candidates: [exact], suggestedActions: [], message: exact.softDeleted ? '联系人已删除，可按原记录恢复' : '邮箱已存在，不能重复新建' };
    }
    return { status: 'duplicate', level: 'exact_email', candidate: exact, candidates: [exact], suggestedActions: [], message: '邮箱已存在，不能重复新建' };
  }
  if (privateExact) {
    return { status: 'restricted_conflict', level: 'exact_email', candidates: [], suggestedActions: [], message: '邮箱与受限记录冲突，请核实来源或归属' };
  }
  if (input.target?.customerId && !input.checkCompany) {
    return { status: 'clear', level: 'none', candidates: [], suggestedActions: ['create_new'], message: '可在现有客户下新增联系人' };
  }
  const domain = normalizeCompanyDomain(input.company.domain);
  const companyMatches = candidates
    .filter(candidate => ['exact_domain', 'exact_company', 'strong_company'].includes(candidate.level ?? 'none'))
    .filter(candidate => domain || candidate.level !== 'exact_domain')
    .filter(candidate => candidate.companyId !== input.target?.companyId);
  const resolved = accessibleByCompany(companyMatches);
  const restricted = resolved.find(candidate => !candidate.canResolve);
  const candidate = resolved.find(item => item.canResolve);
  if (restricted && (!candidate || (restricted.score ?? 0) >= (candidate.score ?? 0))) {
    return { status: 'restricted_conflict', level: restricted.level ?? 'exact_company', candidates: [], suggestedActions: [], message: '公司信息与受限记录冲突，请核实来源或归属' };
  }
  if (candidate) {
    return {
      status: 'needs_resolution', level: candidate.level ?? 'strong_company', candidate,
      candidates: resolved.slice(0, LEAD_INGRESS_LIMITS.candidates),
      suggestedActions: candidate.softDeleted && candidate.restorable ? ['restore'] : ['create_new', 'attach_company'],
      message: candidate.level === 'strong_company' ? '存在相似公司，需要人工确认' : '公司已存在，可复用公司或新建独立资料',
    };
  }
  return { status: 'clear', level: 'none', candidates: [], suggestedActions: ['create_new'], message: '未发现冲突' };
}

/** Adapter normalization keeps visible candidates and persisted IDs on the same matcher. */
export function classifyCompanyCandidates(
  input: LeadIngressCompanyInput,
  candidates: readonly {
    companyId: number; name: string; domain?: string | null; country?: string | null;
    contactName?: string | null; customerId?: string; contactId?: number;
    softDeleted?: boolean; contactVersion?: number; canResolve: boolean; restorable: boolean;
    origin?: string | null; ownerUserId?: string | null; createdBy?: string | null; customerState?: string | null;
  }[],
): LeadIngressCandidateSnapshot[] {
  const grouped = new Map<number, typeof candidates[number][]>();
  for (const candidate of candidates) grouped.set(candidate.companyId, [...(grouped.get(candidate.companyId) ?? []), candidate]);
  const result: LeadIngressCandidateSnapshot[] = [];
  for (const rows of grouped.values()) {
    const representative = rows.find(row => row.canResolve) ?? rows[0]!;
    const matched = matchCompanyConflict(
      { companyName: input.name, domain: input.domain, country: input.country },
      rows.map(row => ({ companyId: row.companyId, name: row.name, domain: row.domain, country: row.country })),
    );
    if (!matched) continue;
    result.push({
      ...representative, level: matched.level, score: matched.score,
      companyName: matched.name, domain: matched.domain ?? representative.domain, country: matched.country ?? representative.country,
    });
  }
  return result;
}

export function normalizedLeadIngressKeys(input: LeadIngressInput): { email: string; domain: string; company: string; country: string } {
  return {
    email: normalizeLeadEmail(input.contacts.find(contact => normalizeLeadEmail(contact.email))?.email),
    domain: normalizeCompanyDomain(input.company.domain),
    company: normalizeCompanyName(input.company.name),
    country: (input.company.country ?? '').trim().toLowerCase(),
  };
}
