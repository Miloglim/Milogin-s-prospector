export const QUOTE_CASE_STATES = [
  'detected', 'fields_pending', 'queries_prepared', 'querying', 'candidates_ready',
  'draft_ready', 'review_pending', 'review_rejected', 'approved', 'sent',
  'negotiating', 'accepted', 'rejected', 'expired',
] as const;
export type QuoteCaseState = typeof QUOTE_CASE_STATES[number];

export const QUOTE_FIELD_KEYS = [
  'pol', 'pod', 'containerTypes', 'quantity', 'commodity', 'weight', 'carrierPreference',
  'carrierExclusion', 'etd', 'validity', 'incoterm', 'specialRequirements', 'targetPrice',
] as const;
export type QuoteFieldKey = typeof QUOTE_FIELD_KEYS[number];

export interface QuoteFieldValue {
  value: string | string[];
  source: 'email' | 'quote' | 'history' | 'user';
  evidence: string[];
  confidence: number;
  resolver: string | null;
}

export type QuoteFields = Partial<Record<QuoteFieldKey, QuoteFieldValue>>;

export interface QuoteCandidate {
  id: string;
  carrier: string | null;
  pol: string | null;
  pod: string | null;
  containerType: string | null;
  price: number | null;
  currency: string | null;
  etd: string | null;
  validFrom: string | null;
  validTo: string | null;
  sourceUpdatedAt: string | null;
  evidence: unknown[];
}

export interface QuoteDraft {
  quoteId: string;
  quoteCaseId: string;
  version: number;
  status: QuoteCaseState;
  fields: QuoteFields;
  missingFields: QuoteFieldKey[];
  selectedCandidate: QuoteCandidate | null;
  candidates: QuoteCandidate[];
  subject: string | null;
  body: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QuoteCase {
  quoteCaseId: string;
  caseId: string;
  messageKey: string;
  threadKey: string;
  state: QuoteCaseState;
  fields: QuoteFields;
  missingFields: QuoteFieldKey[];
  selectedQuote: QuoteCandidate | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface QuoteCaseDetail {
  quoteCase: QuoteCase;
  draft: QuoteDraft;
}

export interface UpsertQuoteCaseInput {
  caseId: string;
  messageKey: string;
  threadKey: string;
  fields: QuoteFields;
  missingFields?: QuoteFieldKey[];
  state?: QuoteCaseState;
  selectedCandidate?: QuoteCandidate | null;
  candidates?: QuoteCandidate[];
  subject?: string | null;
  body?: string | null;
  reason?: string | null;
}

export interface QuoteReviewRequest {
  reviewId: string;
  quoteId: string;
  requestedBy: string;
  reviewerUserId: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  reason: string | null;
  decisionNote: string | null;
  linkedMessageId: string | null;
  linkedTaskId: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface QuoteReviewListItem extends QuoteReviewRequest {
  quoteCaseId: string;
  caseId: string;
  requestedByName: string;
  customerName: string;
  subject: string | null;
  selectedCandidate: QuoteCandidate | null;
  candidates: QuoteCandidate[];
}

export interface QuoteReviewPage { items: QuoteReviewListItem[]; total: number; }

export const QUOTE_REVIEW_ROUTES = {
  reviews: '/api/crm/quote-cases/reviews',
  decision: 'decision',
} as const;

const QUOTE_TRANSITIONS: Record<QuoteCaseState, readonly QuoteCaseState[]> = {
  detected: ['fields_pending', 'queries_prepared'],
  fields_pending: ['queries_prepared', 'expired'],
  queries_prepared: ['querying', 'expired'],
  querying: ['candidates_ready', 'fields_pending', 'expired'],
  candidates_ready: ['draft_ready', 'querying', 'expired'],
  draft_ready: ['review_pending', 'approved', 'querying', 'candidates_ready', 'expired'],
  review_pending: ['approved', 'review_rejected', 'expired'],
  review_rejected: ['draft_ready', 'querying', 'expired'],
  approved: ['sent', 'expired'],
  sent: ['accepted', 'rejected', 'negotiating'],
  negotiating: ['draft_ready', 'accepted', 'rejected', 'expired'],
  accepted: [],
  rejected: ['draft_ready'],
  expired: ['querying'],
};

export function canTransitionQuote(from: QuoteCaseState, to: QuoteCaseState): boolean {
  return from === to || (QUOTE_TRANSITIONS[from] || []).includes(to);
}

export function missingQuoteFields(fields: QuoteFields): QuoteFieldKey[] {
  const required: QuoteFieldKey[] = ['pol', 'pod'];
  return required.filter(key => {
    const value = fields[key]?.value;
    return Array.isArray(value) ? value.length === 0 : !String(value || '').trim();
  });
}

export function mergeQuoteFieldEdit(fields: QuoteFields, key: QuoteFieldKey, value: string | string[]): QuoteFields {
  return { ...fields, [key]: { value, source: 'user', evidence: [], confidence: 1, resolver: null } };
}

export function quoteNeedsRequery(previous: QuoteFields, next: QuoteFields): boolean {
  const keys: QuoteFieldKey[] = ['pol', 'pod', 'containerTypes', 'quantity', 'carrierPreference', 'carrierExclusion', 'etd'];
  return keys.some(key => JSON.stringify(previous[key]?.value ?? null) !== JSON.stringify(next[key]?.value ?? null));
}
