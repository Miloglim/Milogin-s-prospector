import type { TokenPort } from '../core/auth';
import { failure, type Result } from '../core/crm';
import {
  QUOTE_CASE_STATES,
  QUOTE_FIELD_KEYS,
  type QuoteCandidate,
  type QuoteCaseDetail,
  type QuoteCaseState,
  type QuoteFieldKey,
  type QuoteFields,
  type QuoteFieldValue,
  type QuoteReviewRequest,
  type QuoteReviewPage,
  type UpsertQuoteCaseInput,
} from '../core/quote-case';
import type { PostgresQuoteCaseRepository } from '../adapters/postgres/quote-case-repository';

export const QUOTE_ROUTES = {
  list: '/api/crm/quote-cases',
  upsert: '/api/crm/quote-cases/upsert',
  reviews: '/api/crm/quote-cases/reviews',
} as const;

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const QUOTE_REVIEW_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
type QuoteReviewStatus = typeof QUOTE_REVIEW_STATUSES[number];
const text = (value: unknown, max = 500): value is string => typeof value === 'string' && !!value.trim() && value.trim().length <= max;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function quoteState(value: unknown): QuoteCaseState | null {
  return typeof value === 'string' && (QUOTE_CASE_STATES as readonly string[]).includes(value) ? value as QuoteCaseState : null;
}

function fields(value: unknown): QuoteFields | null {
  if (!record(value)) return null;
  const result: QuoteFields = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!(QUOTE_FIELD_KEYS as readonly string[]).includes(key) || !record(raw)) continue;
    const fieldValue = raw.value;
    if (!(typeof fieldValue === 'string' || Array.isArray(fieldValue) && fieldValue.every(item => typeof item === 'string'))) return null;
    if (typeof fieldValue === 'string' && fieldValue.length > 500 || Array.isArray(fieldValue) && fieldValue.length > 20 || Array.isArray(fieldValue) && fieldValue.some(item => item.length > 120)) return null;
    if (!['email', 'quote', 'history', 'user'].includes(String(raw.source))) return null;
    if (!Array.isArray(raw.evidence) || raw.evidence.length > 20 || raw.evidence.some(item => typeof item !== 'string' || item.length > 500)) return null;
    if (typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1) return null;
    result[key as QuoteFieldKey] = {
      value: fieldValue, source: raw.source as QuoteFieldValue['source'],
      evidence: raw.evidence as string[], confidence: raw.confidence,
      resolver: typeof raw.resolver === 'string' ? raw.resolver.slice(0, 120) : null,
    };
  }
  return result;
}

function candidates(value: unknown): QuoteCandidate[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) return null;
  const result: QuoteCandidate[] = [];
  for (const item of value) {
    if (!record(item) || !text(item.id, 200)) return null;
    const optional = (key: string): string | null => typeof item[key] === 'string' ? String(item[key]).slice(0, 300) : null;
    if (item.price !== null && item.price !== undefined && (typeof item.price !== 'number' || !Number.isFinite(item.price))) return null;
    if (!Array.isArray(item.evidence) || item.evidence.length > 20) return null;
    result.push({
      id: item.id.trim(), carrier: optional('carrier'), pol: optional('pol'), pod: optional('pod'),
      containerType: optional('containerType'), price: typeof item.price === 'number' ? item.price : null,
      currency: optional('currency'), etd: optional('etd'), validFrom: optional('validFrom'),
      validTo: optional('validTo'), sourceUpdatedAt: optional('sourceUpdatedAt'), evidence: item.evidence,
    });
  }
  return result;
}

function parsedUpsert(value: unknown): Result<UpsertQuoteCaseInput> {
  if (!record(value) || !text(value.caseId, 100) || !text(value.messageKey, 500) || !text(value.threadKey, 500)) return failure('INVALID_INPUT', '报价 Case 参数无效');
  const parsedFields = fields(value.fields);
  if (!parsedFields) return failure('INVALID_INPUT', '报价字段无效');
  const parsedCandidates = candidates(value.candidates);
  if (!parsedCandidates) return failure('INVALID_INPUT', '报价候选无效');
  const state = value.state === undefined ? undefined : quoteState(value.state);
  if (value.state !== undefined && !state) return failure('INVALID_INPUT', '报价状态无效');
  const missing = value.missingFields === undefined ? undefined : Array.isArray(value.missingFields) && value.missingFields.every(item => (QUOTE_FIELD_KEYS as readonly string[]).includes(String(item))) ? value.missingFields as QuoteFieldKey[] : null;
  if (missing === null) return failure('INVALID_INPUT', '缺失字段无效');
  const selected = value.selectedCandidate === undefined || value.selectedCandidate === null ? null : candidates([value.selectedCandidate]);
  if (value.selectedCandidate !== undefined && value.selectedCandidate !== null && !selected) return failure('INVALID_INPUT', '已选报价无效');
  return {
    ok: true,
    data: {
      caseId: value.caseId.trim(), messageKey: value.messageKey.trim(), threadKey: value.threadKey.trim(),
      fields: parsedFields, missingFields: missing, state: state ?? undefined, selectedCandidate: selected?.[0] ?? null,
      candidates: parsedCandidates,
      subject: typeof value.subject === 'string' ? value.subject.slice(0, 500) : null,
      body: typeof value.body === 'string' ? value.body.slice(0, 100_000) : null,
      reason: typeof value.reason === 'string' ? value.reason.slice(0, 500) : null,
    },
  };
}

export function createQuoteService(repo: PostgresQuoteCaseRepository, tokens: TokenPort) {
  return {
    list(token: string, input: { caseId?: string; messageKey?: string; limit?: number; offset?: number }) {
      const limit = input.limit ?? 25;
      const offset = input.offset ?? 0;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) return Promise.resolve(failure('INVALID_INPUT', '分页参数无效'));
      if (input.caseId !== undefined && !text(input.caseId, 100) || input.messageKey !== undefined && !text(input.messageKey, 500)) return Promise.resolve(failure('INVALID_INPUT', '报价查询参数无效'));
      return repo.list(tokens.hash(token), { caseId: input.caseId, messageKey: input.messageKey, limit, offset });
    },
    detail(token: string, quoteCaseId: string) {
      if (!text(quoteCaseId, 100)) return Promise.resolve(failure('INVALID_INPUT', '报价 Case ID 无效'));
      return repo.detail(tokens.hash(token), quoteCaseId);
    },
    upsert(token: string, input: unknown): Promise<Result<QuoteCaseDetail>> {
      const parsed = parsedUpsert(input);
      return parsed.ok ? repo.upsert(tokens.hash(token), parsed.data) : Promise.resolve(parsed);
    },
    requery(token: string, quoteCaseId: string, input: unknown): Promise<Result<QuoteCaseDetail>> {
      if (!text(quoteCaseId, 100) || !record(input)) return Promise.resolve(failure('INVALID_INPUT', '重新查询参数无效'));
      return repo.detail(tokens.hash(token), quoteCaseId).then(current => {
        if (!current.ok) return current;
        const draft = current.data.draft;
        const parsed = parsedUpsert({
          ...input, caseId: current.data.quoteCase.caseId, messageKey: current.data.quoteCase.messageKey,
          threadKey: current.data.quoteCase.threadKey, fields: input.fields ?? draft.fields,
          candidates: input.candidates ?? draft.candidates, selectedCandidate: input.selectedCandidate ?? draft.selectedCandidate,
        });
        return parsed.ok ? repo.upsert(tokens.hash(token), parsed.data) : Promise.resolve(parsed);
      });
    },
    select(token: string, quoteCaseId: string, input: unknown): Promise<Result<QuoteCaseDetail>> {
      if (!text(quoteCaseId, 100) || !record(input)) return Promise.resolve(failure('INVALID_INPUT', '选择报价参数无效'));
      return repo.detail(tokens.hash(token), quoteCaseId).then(current => {
        if (!current.ok) return current;
        const selectedCandidates = candidates([input]);
        if (!selectedCandidates?.length) return failure('INVALID_INPUT', '选择报价参数无效');
        const value = current.data.draft;
        return repo.upsert(tokens.hash(token), {
          caseId: current.data.quoteCase.caseId, messageKey: current.data.quoteCase.messageKey,
          threadKey: current.data.quoteCase.threadKey, fields: value.fields, missingFields: value.missingFields,
          state: 'draft_ready', selectedCandidate: selectedCandidates[0]!, candidates: value.candidates,
          subject: value.subject, body: value.body, reason: 'user_selected_quote',
        });
      });
    },
    review(token: string, quoteId: string, input: unknown): Promise<Result<QuoteReviewRequest>> {
      if (!text(quoteId, 100) || !record(input) || !text(input.reviewerUserId, 100) || !UUID.test(input.reviewerUserId)) return Promise.resolve(failure('INVALID_INPUT', '报价审核参数无效'));
      if (input.reason !== undefined && (typeof input.reason !== 'string' || input.reason.length > 500) || input.linkedMessageId !== undefined && (typeof input.linkedMessageId !== 'string' || input.linkedMessageId.length > 500) || input.linkedTaskId !== undefined && (typeof input.linkedTaskId !== 'string' || input.linkedTaskId.length > 100)) return Promise.resolve(failure('INVALID_INPUT', '报价审核参数无效'));
      return repo.review(tokens.hash(token), quoteId, {
        reviewerUserId: input.reviewerUserId, reason: typeof input.reason === 'string' ? input.reason : undefined,
        linkedMessageId: typeof input.linkedMessageId === 'string' ? input.linkedMessageId : undefined,
        linkedTaskId: typeof input.linkedTaskId === 'string' ? input.linkedTaskId : undefined,
      });
    },
    listReviews(token: string, input: { status?: string; limit?: number; offset?: number }): Promise<Result<QuoteReviewPage>> {
      const status = input.status ?? 'pending';
      const limit = input.limit ?? 25;
      const offset = input.offset ?? 0;
      if (!(QUOTE_REVIEW_STATUSES as readonly string[]).includes(status)) return Promise.resolve(failure('INVALID_INPUT', '审核状态无效'));
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) return Promise.resolve(failure('INVALID_INPUT', '分页参数无效'));
      return repo.listReviews(tokens.hash(token), status as QuoteReviewStatus, limit, offset);
    },
    decideReview(token: string, reviewId: string, input: unknown): Promise<Result<QuoteReviewRequest>> {
      if (!text(reviewId, 100) || !UUID.test(reviewId)) return Promise.resolve(failure('INVALID_INPUT', '审核 ID 无效'));
      if (!record(input) || (input.action !== 'approve' && input.action !== 'reject')) return Promise.resolve(failure('INVALID_INPUT', '审核动作无效'));
      if (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 500)) return Promise.resolve(failure('INVALID_INPUT', '审核意见无效'));
      return repo.decideReview(tokens.hash(token), reviewId, input.action, typeof input.note === 'string' ? input.note : undefined);
    },
  };
}

export type QuoteService = ReturnType<typeof createQuoteService>;
