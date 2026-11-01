import type { TokenPort } from '../core/auth';
import { failure, success, type Result } from '../core/crm';
import { MAIL_CLASSIFICATIONS } from '../core/contact-mail';
import {
  CONTACT_MAIL_ANALYSIS_LIMITS as L,
  MAIL_INTENT_CODES,
  MAIL_PRIORITIES,
  MAIL_RELEVANCE_VALUES,
  type ContactMailAnalysisCorrection,
  type ContactMailAnalysisQuery,
  type ContactMailAnalysisRepository,
  type ContactMailAnalysisSubmission,
  type MailBusinessSignal,
} from '../core/mail-analysis';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}
function text(value: unknown, max: number, min = 0): value is string {
  return typeof value === 'string' && value.length <= max && value.trim().length >= min && !value.includes('\0');
}
function nullableText(value: unknown, max: number): value is string | null {
  return value === null || text(value, max);
}
function confidence(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}
function base(value: Record<string, unknown>): boolean {
  return Number.isSafeInteger(value.contactId) && Number(value.contactId) > 0
    && typeof value.customerId === 'string' && UUID.test(value.customerId)
    && text(value.mailboxKey, 128, 1) && text(value.messageKey, 256, 1)
    && typeof value.contentHash === 'string' && HASH.test(value.contentHash);
}
function signals(value: unknown): value is MailBusinessSignal[] {
  return Array.isArray(value) && value.length <= L.signals && value.every(signal =>
    record(signal) && keys(signal, ['code','label','confidence','evidence'])
    && MAIL_INTENT_CODES.includes(signal.code as never)
    && text(signal.label, L.label, 1) && confidence(signal.confidence)
    && text(signal.evidence, L.evidenceItem, 1));
}
function evidence(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= L.evidence && value.every(item => text(item, L.evidenceItem, 1));
}
function conclusion(value: Record<string, unknown>): boolean {
  return MAIL_CLASSIFICATIONS.includes(value.classification as never)
    && MAIL_RELEVANCE_VALUES.includes(value.relevance as never)
    && text(value.summary, L.summary)
    && signals(value.signals)
    && typeof value.requiresAction === 'boolean'
    && nullableText(value.nextAction, L.nextAction)
    && MAIL_PRIORITIES.includes(value.priority as never)
    && nullableText(value.dueHint, L.dueHint)
    && confidence(value.confidence)
    && evidence(value.evidence);
}

export function contactMailAnalysisQuery(value: unknown): Result<ContactMailAnalysisQuery> {
  if (!record(value) || !keys(value, ['contactId','customerId','mailboxKey','messageKey','contentHash','includeHistory','historyLimit']) || !base(value)) return failure('INVALID_INPUT', '邮件分析查询参数无效');
  const includeHistory = value.includeHistory === true;
  const historyLimit = value.historyLimit ?? 20;
  if (typeof includeHistory !== 'boolean' || !Number.isSafeInteger(historyLimit) || Number(historyLimit) < 1 || Number(historyLimit) > L.history) return failure('INVALID_INPUT', '邮件分析历史参数无效');
  return success({ ...(value as unknown as ContactMailAnalysisQuery), includeHistory, historyLimit: Number(historyLimit) });
}

export function contactMailAnalysisSubmission(value: unknown): Result<ContactMailAnalysisSubmission> {
  if (!record(value) || !keys(value, ['contactId','customerId','mailboxKey','messageKey','contentHash','inputSequence','idempotencyKey','result']) || !base(value) || !Number.isSafeInteger(value.inputSequence) || Number(value.inputSequence) < 0 || !text(value.idempotencyKey, 256, 1) || !record(value.result)) return failure('INVALID_INPUT', 'AI 邮件分析参数无效');
  const result = value.result;
  if (!keys(result, ['classification','relevance','summary','signals','actionability','confidence','evidence','analyzerVersion']) || !MAIL_CLASSIFICATIONS.includes(result.classification as never) || !MAIL_RELEVANCE_VALUES.includes(result.relevance as never) || !text(result.summary, L.summary) || !signals(result.signals) || !record(result.actionability) || !confidence(result.confidence) || !evidence(result.evidence) || !text(result.analyzerVersion, L.version, 1)) return failure('INVALID_INPUT', 'AI 邮件分析结论无效');
  const actionability = result.actionability;
  if (!keys(actionability, ['requiresAction','nextAction','priority','dueHint']) || typeof actionability.requiresAction !== 'boolean' || !nullableText(actionability.nextAction, L.nextAction) || !MAIL_PRIORITIES.includes(actionability.priority as never) || !nullableText(actionability.dueHint, L.dueHint)) return failure('INVALID_INPUT', 'AI 行动建议无效');
  if (actionability.requiresAction && !text(actionability.nextAction, L.nextAction, 1)) return failure('INVALID_INPUT', '行动建议缺少下一步');
  if (result.relevance !== 'customer_business' && actionability.requiresAction) return failure('INVALID_INPUT', '非客户业务邮件不能生成行动建议');
  return success(value as unknown as ContactMailAnalysisSubmission);
}

export function contactMailAnalysisCorrection(value: unknown): Result<ContactMailAnalysisCorrection> {
  if (!record(value) || !keys(value, ['contactId','customerId','mailboxKey','messageKey','contentHash','idempotencyKey','expectedCurrentId','classification','relevance','summary','signals','requiresAction','nextAction','priority','dueHint','confidence','evidence']) || !base(value) || !text(value.idempotencyKey, 256, 1) || !text(value.expectedCurrentId, 64, 1) || !conclusion(value)) return failure('INVALID_INPUT', '人工邮件分析参数无效');
  if (value.requiresAction === true && !text(value.nextAction, L.nextAction, 1)) return failure('INVALID_INPUT', '行动建议缺少下一步');
  if (/* Human confirmation may make a matched business mail actionable, but never turns unrelated mail into customer business. */ value.relevance !== 'customer_business' && value.requiresAction) return failure('INVALID_INPUT', '非客户业务邮件不能确认行动建议');
  return success(value as unknown as ContactMailAnalysisCorrection);
}

export interface ContactMailAnalysisService {
  current(token:string,value:unknown):Promise<Result<import('../core/mail-analysis').ContactMailAnalysisView>>;
  submitAI(token:string,value:unknown):Promise<Result<import('../core/mail-analysis').ContactMailAnalysisRecord>>;
  correct(token:string,value:unknown):Promise<Result<import('../core/mail-analysis').ContactMailAnalysisRecord>>;
}

export function createContactMailAnalysisService(repo: ContactMailAnalysisRepository, tokens: TokenPort): ContactMailAnalysisService {
  const run = <I,T>(token:string,value:unknown,parse:(input:unknown)=>Result<I>,action:(hash:string,input:I)=>Promise<Result<T>>):Promise<Result<T>> => {
    if (!TOKEN.test(token)) return Promise.resolve(failure('UNAUTHORIZED', '会话无效'));
    const parsed = parse(value);
    return parsed.ok ? action(tokens.hash(token), parsed.data) : Promise.resolve(parsed);
  };
  return {
    current:(token,value)=>run(token,value,contactMailAnalysisQuery,(hash,input)=>repo.current(hash,input)),
    submitAI:(token,value)=>run(token,value,contactMailAnalysisSubmission,(hash,input)=>repo.submitAI(hash,input)),
    correct:(token,value)=>run(token,value,contactMailAnalysisCorrection,(hash,input)=>repo.correct(hash,input)),
  };
}
