import type { ContactMailKind, MailClassification } from './contact-mail';

export const MAIL_RELEVANCE_VALUES = ['customer_business', 'internal', 'notification', 'vendor', 'spam', 'unknown'] as const;
export type MailRelevance = typeof MAIL_RELEVANCE_VALUES[number];
export const MAIL_INTENT_CODES = ['price_inquiry', 'quote_request', 'schedule_request', 'order_followup', 'complaint', 'cooperation', 'no_action', 'other'] as const;
export type MailIntentCode = typeof MAIL_INTENT_CODES[number];
export const MAIL_PRIORITIES = ['normal', 'important', 'urgent'] as const;
export type MailPriority = typeof MAIL_PRIORITIES[number];
export const MAIL_ANALYSIS_SOURCES = ['rule', 'ai', 'human'] as const;
export type MailAnalysisSource = typeof MAIL_ANALYSIS_SOURCES[number];
export const MAIL_CONTACT_STATES = ['contacted', 'replied', 'bounced', 'autoreply'] as const;
export type MailContactState = typeof MAIL_CONTACT_STATES[number];

export const CONTACT_MAIL_ANALYSIS_ROUTES = {
  analyses: '/api/crm/contact-mail-analyses',
  ai: '/api/crm/contact-mail-analyses/ai',
  correct: '/api/crm/contact-mail-analyses/correct',
} as const;
export const CONTACT_MAIL_ANALYSIS_LIMITS = {
  version: 80,
  summary: 2000,
  nextAction: 500,
  dueHint: 120,
  evidence: 12,
  evidenceItem: 500,
  signals: 16,
  label: 80,
  history: 100,
  bodyBytes: 65536,
} as const;

export interface MailBusinessSignal {
  code: MailIntentCode;
  label: string;
  confidence: number;
  evidence: string;
}

export interface MailActionability {
  requiresAction: boolean;
  nextAction: string | null;
  priority: MailPriority;
  dueHint: string | null;
}

export interface MailAnalysisResult {
  classification: MailClassification;
  contactState: MailContactState | null;
  relevance: MailRelevance;
  summary: string;
  signals: MailBusinessSignal[];
  actionability: MailActionability;
  confidence: number;
  evidence: string[];
  source: MailAnalysisSource;
  analyzerVersion: string;
}

export interface MechanicalMailAnalysisInput {
  kind: ContactMailKind;
  direction: 'inbound' | 'outbound';
  subject: string;
  preview: string;
  fromEmail: string;
  toEmails: string[];
  ccEmails: string[];
  matchedContact: boolean;
  primaryEmail: string | null;
  internal: boolean;
}

export interface ContactMailAnalysisKey {
  contactId: number;
  customerId: string;
  mailboxKey: string;
  messageKey: string;
  contentHash: string;
}

export interface ContactMailAnalysisQuery extends ContactMailAnalysisKey {
  includeHistory: boolean;
  historyLimit: number;
}

export interface MailTaskSuggestion {
  key: string;
  actionCode: MailIntentCode | 'fix_email';
  nextAction: string;
  priority: MailPriority;
  dueHint: string | null;
}

export interface ContactMailAnalysisRecord extends ContactMailAnalysisKey {
  analysisId: string;
  actorId: string;
  eventId: string | null;
  threadKey: string;
  analyzerVersion: string;
  inputSequence: number;
  source: MailAnalysisSource;
  relevance: MailRelevance;
  classification: MailClassification;
  contactState: MailContactState | null;
  summary: string;
  signals: MailBusinessSignal[];
  requiresAction: boolean;
  nextAction: string | null;
  priority: MailPriority;
  dueHint: string | null;
  confidence: number;
  evidence: string[];
  humanLocked: boolean;
  supersedesId: string | null;
  isCurrent: boolean;
  createdAt: string;
}

export interface ContactMailAnalysisView {
  current: ContactMailAnalysisRecord;
  history: ContactMailAnalysisRecord[];
  canCorrect: boolean;
  access: 'normal' | 'monitor';
  taskSuggestion: MailTaskSuggestion | null;
}

export interface ContactMailAnalysisSubmission extends ContactMailAnalysisKey {
  inputSequence: number;
  idempotencyKey: string;
  result: Omit<MailAnalysisResult, 'source' | 'contactState'>;
}

export interface ContactMailAnalysisCorrection extends ContactMailAnalysisKey {
  idempotencyKey: string;
  expectedCurrentId: string;
  classification: MailClassification;
  relevance: MailRelevance;
  summary: string;
  signals: MailBusinessSignal[];
  requiresAction: boolean;
  nextAction: string | null;
  priority: MailPriority;
  dueHint: string | null;
  confidence: number;
  evidence: string[];
}

export interface ContactMailAnalysisRepository {
  current(tokenHash: string, query: ContactMailAnalysisQuery): Promise<import('./crm').Result<ContactMailAnalysisView>>;
  submitAI(tokenHash: string, input: ContactMailAnalysisSubmission): Promise<import('./crm').Result<ContactMailAnalysisRecord>>;
  correct(tokenHash: string, input: ContactMailAnalysisCorrection): Promise<import('./crm').Result<ContactMailAnalysisRecord>>;
}

export interface MailAnalysisQueueStatus {
  enabled: boolean;
  pending: number;
  running: number;
  retrying: number;
  completed: number;
  failed: number;
  lastError: string | null;
}

const CUSTOMER_BUSINESS_CLASSIFICATIONS: readonly MailClassification[] = ['replied', 'autoreply', 'bounced'];
const INTERNAL_WORDS = ['internal', '内部', '同事', '员工'] as const;
const VENDOR_WORDS = ['invoice', 'receipt', 'subscription', 'newsletter', '广告', '供应商', '账单'] as const;
const SPAM_WORDS = ['unsubscribe', 'promotion', 'marketing', '促销', '营销', '退订'] as const;
const INTENT_RULES: ReadonlyArray<{ code: MailIntentCode; label: string; words: readonly string[] }> = [
  { code: 'complaint', label: '客户投诉', words: ['complaint', 'claim', 'damaged', '投诉', '索赔', '破损', '延误'] },
  { code: 'quote_request', label: '报价请求', words: ['quotation', 'quote', 'rfq', '报价', '询价'] },
  { code: 'price_inquiry', label: '价格咨询', words: ['price', 'rate', 'cost', '价格', '运费'] },
  { code: 'schedule_request', label: '船期确认', words: ['schedule', 'etd', 'eta', 'vessel', '船期', '到港', '交付'] },
  { code: 'order_followup', label: '订单跟进', words: ['order', 'shipment', 'delivery', '订单', '发货', '进度'] },
  { code: 'cooperation', label: '合作沟通', words: ['cooperation', 'partner', '合作', '代理'] },
] as const;

export function mailRelevanceFor(input: { classification: MailClassification; matchedContact: boolean; internal: boolean; ccOnly?: boolean }): MailRelevance {
  if (input.internal) return 'internal';
  if (!input.matchedContact) return input.classification === 'bounced' ? 'notification' : 'unknown';
  if (input.ccOnly) return 'unknown';
  return 'customer_business';
}

export function actionabilityFor(input: { relevance: MailRelevance; classification: MailClassification; intent: MailIntentCode | null; confidence: number }): MailActionability {
  if (input.relevance !== 'customer_business') return { requiresAction: false, nextAction: null, priority: 'normal', dueHint: null };
  if (input.classification === 'bounced') return { requiresAction: true, nextAction: '核对并修正联系人邮箱', priority: 'important', dueHint: '同日内' };
  if (input.classification === 'autoreply' || input.intent === null || input.intent === 'no_action' || input.intent === 'other') return { requiresAction: false, nextAction: null, priority: 'normal', dueHint: null };
  if (input.intent === 'complaint') return { requiresAction: true, nextAction: '优先处理客户问题', priority: 'urgent', dueHint: '24 小时内' };
  if (input.intent === 'price_inquiry' || input.intent === 'quote_request') return { requiresAction: true, nextAction: '回复客户询价', priority: input.confidence >= 0.85 ? 'important' : 'normal', dueHint: '24 小时内' };
  if (input.intent === 'schedule_request') return { requiresAction: true, nextAction: '确认船期或交货安排', priority: 'important', dueHint: '24 小时内' };
  if (input.intent === 'order_followup') return { requiresAction: true, nextAction: '继续跟进订单进度', priority: 'normal', dueHint: '48 小时内' };
  if (input.intent === 'cooperation') return { requiresAction: true, nextAction: '评估合作诉求', priority: 'normal', dueHint: '48 小时内' };
  return { requiresAction: false, nextAction: null, priority: 'normal', dueHint: null };
}

export function isCustomerBusinessMail(analysis: Pick<MailAnalysisResult, 'relevance'>): boolean {
  return analysis.relevance === 'customer_business';
}

export function shouldCreateTaskSuggestion(
  analysis: Pick<MailAnalysisResult, 'relevance' | 'actionability' | 'confidence' | 'source'>,
): boolean {
  if (analysis.relevance !== 'customer_business' || !analysis.actionability.requiresAction) return false;
  return analysis.source === 'human' || analysis.confidence >= 0.75;
}

export function touchesContactFacts(classification: MailClassification): boolean {
  return CUSTOMER_BUSINESS_CLASSIFICATIONS.includes(classification);
}

export function contactStateForMail(kind: ContactMailKind, direction: 'inbound' | 'outbound', fromEmail: string, primaryEmail: string | null): MailContactState | null {
  if (kind === 'sent' && direction === 'outbound') return 'contacted';
  if (kind === 'bounced') return 'bounced';
  if (kind === 'autoreply') return 'autoreply';
  if (kind === 'replied' && direction === 'inbound' && !!primaryEmail && fromEmail.trim().toLowerCase() === primaryEmail.trim().toLowerCase()) return 'replied';
  return null;
}

function containsAny(text: string, words: readonly string[]): string | null {
  return words.find(word => text.includes(word)) ?? null;
}

function detectedIntent(text: string): { code: MailIntentCode; label: string; evidence: string; confidence: number } | null {
  for (const rule of INTENT_RULES) {
    const evidence = containsAny(text, rule.words);
    if (evidence) return { code: rule.code, label: rule.label, evidence, confidence: evidence.length >= 5 ? 0.9 : 0.82 };
  }
  return null;
}

export function mechanicalMailAnalysis(input: MechanicalMailAnalysisInput): MailAnalysisResult {
  const text = `${input.subject}\n${input.preview}`.toLocaleLowerCase();
  const vendor = containsAny(text, VENDOR_WORDS);
  const spam = containsAny(text, SPAM_WORDS);
  const internal = input.internal || !!containsAny(text, INTERNAL_WORDS);
  const classification: MailClassification = input.kind === 'bounced' ? 'bounced'
    : input.kind === 'autoreply' ? 'autoreply'
    : input.kind === 'replied' ? 'replied' : 'other';
  const personalReply = input.kind !== 'replied' || input.direction === 'inbound' && !!input.primaryEmail && input.fromEmail.trim().toLowerCase() === input.primaryEmail.trim().toLowerCase();
  const relevance: MailRelevance = internal ? 'internal'
    : spam ? 'spam'
    : vendor ? 'vendor'
    : mailRelevanceFor({ classification, matchedContact: input.matchedContact && personalReply, internal: false, ccOnly: input.kind === 'cc' });
  const contactState = contactStateForMail(input.kind, input.direction, input.fromEmail, input.primaryEmail);
  const intent = relevance === 'customer_business' ? detectedIntent(text) : null;
  const confidence = relevance === 'customer_business'
    ? input.kind === 'sent' || input.kind === 'replied' || input.kind === 'bounced' || input.kind === 'autoreply'
      ? 0.99
      : intent?.confidence ?? 0.7
    : 0.95;
  const signals: MailBusinessSignal[] = intent ? [{
    code: intent.code,
    label: intent.label,
    confidence: intent.confidence,
    evidence: intent.evidence,
  }] : [];
  const summary = (input.subject.trim() || input.preview.trim() || (input.kind === 'sent' ? '已发出邮件' : '收到邮件')).slice(0, CONTACT_MAIL_ANALYSIS_LIMITS.summary);
  const actionability=actionabilityFor({ relevance, classification, intent: intent?.code ?? null, confidence });
  return {
    classification,
    contactState,
    relevance,
    summary,
    signals,
    actionability: input.kind==='sent'||input.direction==='outbound'?{requiresAction:false,nextAction:null,priority:'normal',dueHint:null}:actionability,
    confidence,
    evidence: signals.map(signal => signal.evidence),
    source: 'rule',
    analyzerVersion: 'mechanical-v1',
  };
}

export function mailThreadKey(subject: string, messageKey: string): string {
  const normalized = subject.trim().toLocaleLowerCase()
    .replace(/^(?:(?:re|fw|fwd|回复|转发)\s*:\s*)+/i, '')
    .replace(/\s+/g, ' ');
  return normalized || `message:${messageKey}`;
}

export function taskSuggestionKey(input: {
  actorId: string;
  contactId: number;
  threadKey: string;
  actionCode: MailIntentCode | 'fix_email';
}): string {
  return [input.actorId, String(input.contactId), input.threadKey, input.actionCode].join('|');
}

export function taskSuggestionFor(record: Pick<ContactMailAnalysisRecord,
  'actorId' | 'contactId' | 'threadKey' | 'signals' | 'classification' |
  'relevance' | 'requiresAction' | 'nextAction' | 'priority' | 'dueHint' | 'confidence' | 'source'>): MailTaskSuggestion | null {
  if (!shouldCreateTaskSuggestion({
    relevance: record.relevance,
    confidence: record.confidence,
    source: record.source,
    actionability: {
      requiresAction: record.requiresAction,
      nextAction: record.nextAction,
      priority: record.priority,
      dueHint: record.dueHint,
    },
  }) || !record.nextAction) return null;
  const actionCode: MailIntentCode | 'fix_email' = record.classification === 'bounced'
    ? 'fix_email'
    : record.signals[0]?.code ?? 'other';
  return {
    key: taskSuggestionKey({ actorId: record.actorId, contactId: record.contactId, threadKey: record.threadKey, actionCode }),
    actionCode,
    nextAction: record.nextAction,
    priority: record.priority,
    dueHint: record.dueHint,
  };
}

export function analysisSourceRank(source: MailAnalysisSource): number {
  return source === 'human' ? 3 : source === 'ai' ? 2 : 1;
}

export function newerAnalysisWins(
  incoming: { source: MailAnalysisSource; inputSequence: number; analyzerVersion: string },
  current: { source: MailAnalysisSource; inputSequence: number; analyzerVersion: string; humanLocked: boolean } | null,
): boolean {
  if (incoming.source === 'human') return true;
  if (!current) return true;
  if (current.source === 'human' || current.humanLocked) return false;
  if (incoming.inputSequence !== current.inputSequence) return incoming.inputSequence > current.inputSequence;
  const rank = analysisSourceRank(incoming.source) - analysisSourceRank(current.source);
  if (rank !== 0) return rank > 0;
  return incoming.analyzerVersion.localeCompare(current.analyzerVersion) > 0;
}
