export const INBOX_LIST_LIMITS = { page: 200, pageMax: 500, search: 200 } as const;

/** Cursor pagination keeps the Foxmail-style continuous list without loading the whole mailbox. */
export interface InboxListRequest {
  includeId?: number;
  centerMessageKey?: string;
  limit?: number;
  cursor?: string;
  search?: string;
  classification?: string;
  accountId?: number;
  startAt?: string;
  endAt?: string;
}

export interface InboxListPage<T = unknown> {
  items: T[];
  total: number;
  nextCursor: string | null;
}

/** Sidebar/calendar aggregates stay independent of the active classification or search. */
export interface InboxSummaryRequest {
  accountId?: number;
  startAt?: string;
  endAt?: string;
}

export interface InboxSummaryCount {
  total: number;
  unread: number;
  latestAt?: number;
  email?: string;
}

export interface InboxSummary {
  total: number;
  allTotal: number;
  unread: number;
  byClassification: Record<string, InboxSummaryCount>;
  byDate: Record<string, InboxSummaryCount>;
  byAccount: Record<string, InboxSummaryCount>;
  labels: Record<string, number>;
  pinned: number;
  conversations: unknown[];
  pinnedItems: unknown[];
}

export function normalizeInboxSubject(value: string | null | undefined): string {
  return (value || '')
    .replace(/^((re|res|fw|fwd|aw|sv|回复|答复|回覆|转发|轉寄)\s*[:：]\s*)+/i, '')
    .trim()
    .toLocaleLowerCase('zh-CN');
}

export interface InboxLabel {
  labelId: number;
  name: string;
  color: string;
  count: number;
  source?: 'user' | 'ai';
  status?: 'active' | 'suggested';
  candidateCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface InboxLabelSaveRequest {
  labelId?: number;
  name: string;
  color: string;
  idempotencyKey: string;
}

export interface InboxLabelDeleteRequest {
  labelId: number;
  idempotencyKey: string;
}

export interface InboxMessageLabelsRequest {
  messageId: number;
  labelIds: number[];
  idempotencyKey: string;
}

export interface InboxMessagesLabelsBatchRequest {
  messageIds: number[];
  labelIds: number[];
  idempotencyKey: string;
}

export interface InboxMessagesPinBatchRequest {
  messageIds: number[];
  pinned: boolean;
  idempotencyKey: string;
}

export interface InboxFolderSuggestionRequest {
  suggestions: Array<{ name: string; messageIds: number[] }>;
  idempotencyKey: string;
}

export interface InboxFolderConfirmRequest {
  labelId: number;
  idempotencyKey: string;
}

export interface InboxPinMessageRequest {
  messageId: number;
  pinned: boolean;
  idempotencyKey: string;
}

export interface InboxReadStateRequest {
  messageIds: number[];
  read: boolean;
  idempotencyKey: string;
}

export const INBOX_TODO_STATES = ['open', 'done'] as const;
export type InboxTodoState = typeof INBOX_TODO_STATES[number];

export interface InboxTodoStateRequest {
  messageId: number;
  state: InboxTodoState;
  idempotencyKey: string;
}

export interface InboxTodoStateResult {
  messageId: number;
  state: InboxTodoState;
  changed: boolean;
}

export interface InboxTodoBatchRequest {
  messageIds: number[];
  state: InboxTodoState;
  idempotencyKey: string;
}

export interface InboxTodoBatchResult {
  messageIds: number[];
  updated: number;
  state: InboxTodoState;
}

export const INBOX_CONVERSATION_STATES = ['todo', 'needs_reply', 'waiting_other', 'important'] as const;
export type InboxConversationState = typeof INBOX_CONVERSATION_STATES[number];

export interface InboxConversationStateBatchRequest {
  messageIds: number[];
  state: InboxConversationState | null;
  idempotencyKey: string;
}

export interface InboxConversationStateBatchResult {
  messageIds: number[];
  updated: number;
  state: InboxConversationState | null;
}

export const INBOX_FETCH_PHASES = {
  CONNECTING: "connecting",
  SEARCHING: "searching",
  SCANNING: "scanning",
  CALIBRATING: "calibrating",
  PROCESSING: "processing",
  POST_PROCESSING: "post_processing",
  COMPLETE: "complete",
  FAILED: "failed",
} as const;

export type InboxFetchPhase = (typeof INBOX_FETCH_PHASES)[keyof typeof INBOX_FETCH_PHASES];

/** Account-scoped refresh snapshot. `total` is the current 500-mail batch, not the mailbox size. */
export interface InboxFetchProgress {
  accountId: number;
  email?: string;
  phase: InboxFetchPhase;
  scanned: number;
  total: number;
  newCount: number;
  remaining: number;
  processedCount?: number;
  requiredCount?: number;
  message?: string;
  currentSubject?: string | null;
}

export const INBOX_SYNC_PHASES = {
  UNCONFIGURED: 'unconfigured',
  IDLE: 'idle',
  INITIAL: 'initial',
  HISTORY: 'history',
  READY: 'ready',
  PARTIAL: 'partial',
  FAILED: 'failed',
} as const;

export type InboxSyncPhase = (typeof INBOX_SYNC_PHASES)[keyof typeof INBOX_SYNC_PHASES];

export interface InboxSyncAccountState {
  accountId: number;
  email: string;
  hasImap: boolean;
  phase: InboxSyncPhase;
  windowFromAt: string | null;
  windowToAt: string | null;
  targetCount: number;
  scannedCount: number;
  newCount: number;
  matchedCount: number;
  remainingCount: number;
  firstCompletedAt: string | null;
  lastIncrementalAt: string | null;
  lastError: string | null;
  updatedAt: string | null;
}

export interface InboxSyncSnapshot {
  accounts: InboxSyncAccountState[];
  initializing: boolean;
  failed: boolean;
}

export interface InboxHistoryRequest {
  accountId?: number;
  months?: number;
}

export const INBOX_ANALYSIS_CATEGORIES = [
  'reply_needed', 'price_inquiry', 'quote_request', 'schedule_request', 'order_followup',
  'complaint', 'cooperation', 'rate_update', 'notification', 'invoice', 'recruitment', 'marketing', 'personal', 'spam', 'other',
] as const;
export type InboxAnalysisCategory = (typeof INBOX_ANALYSIS_CATEGORIES)[number];
export const INBOX_ANALYSIS_PRIORITIES = ['normal', 'important', 'urgent'] as const;
export type InboxAnalysisPriority = (typeof INBOX_ANALYSIS_PRIORITIES)[number];

export const INBOX_ANALYSIS_CATEGORY_LABELS: Record<InboxAnalysisCategory, string> = {
  reply_needed: '待回复', price_inquiry: '询价', quote_request: '报价请求', schedule_request: '船期',
  order_followup: '订单跟进', complaint: '投诉', cooperation: '合作', rate_update: '运价更新', notification: '通知',
  invoice: '账单', recruitment: '招聘', marketing: '推广', personal: '私人', spam: '垃圾邮件', other: '其他',
};

export interface InboxAnalysisView {
  messageId: number;
  category: InboxAnalysisCategory;
  priority: InboxAnalysisPriority;
  requiresAction: boolean;
  summary: string;
  nextAction: string | null;
  dueHint: string | null;
  confidence: number;
  evidence: string[];
  source: 'rule' | 'ai' | 'human' | 'mock';
  analyzerVersion: string;
  status: 'pending' | 'ready' | 'failed';
  error: string | null;
  updatedAt: string;
}

export const INBOX_DIRECT_BUSINESS_ANALYSIS_CATEGORIES = [
  'price_inquiry', 'quote_request', 'schedule_request', 'order_followup', 'complaint', 'cooperation',
] as const;

export const INBOX_AI_TODO_CONFIDENCE = 0.75;

export interface InboxAnalysisAdmission {
  internal: boolean;
  ccOnly: boolean;
}

/** Direct customer business with a clear action becomes a todo; internal and cc copies never do. */
export function inboxAnalysisAdmitsTodo(
  analysis: Pick<InboxAnalysisView, 'status' | 'category' | 'priority' | 'requiresAction' | 'confidence'> | null | undefined,
  admission: InboxAnalysisAdmission,
): boolean {
  if (!analysis || analysis.status !== 'ready' || admission.ccOnly || admission.internal) return false;
  if (!(INBOX_DIRECT_BUSINESS_ANALYSIS_CATEGORIES as readonly string[]).includes(analysis.category)) return false;
  return (analysis.requiresAction && analysis.confidence >= INBOX_AI_TODO_CONFIDENCE) || analysis.priority === 'urgent';
}

/** Actionable mail that is not a direct-business todo belongs in the attention bucket. */
export function inboxAnalysisAdmitsAttention(
  analysis: Pick<InboxAnalysisView, 'status' | 'category' | 'priority' | 'requiresAction' | 'confidence'> | null | undefined,
  admission: InboxAnalysisAdmission,
): boolean {
  if (!analysis || analysis.status !== 'ready' || admission.ccOnly) return false;
  return analysis.requiresAction && !inboxAnalysisAdmitsTodo(analysis, admission);
}

export interface InboxAnalysisStatus {
  enabled: boolean;
  pending: number;
  ready: number;
  failed: number;
}

export const INBOX_QUOTE_CARD_STATES = ['analyzing','fields_pending','querying','ready','failed','unmatched','stale'] as const;
export type InboxQuoteCardState = typeof INBOX_QUOTE_CARD_STATES[number];

export interface InboxQuoteCandidate {
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

export interface InboxQuoteCard {
  messageId: number;
  messageKey: string;
  caseId: string;
  quoteCaseId: string;
  quoteId: string;
  state: InboxQuoteCardState;
  fields: Record<string, unknown>;
  missingFields: string[];
  selectedCandidate: InboxQuoteCandidate | null;
  candidates: InboxQuoteCandidate[];
  summary: string;
  error: string | null;
  updatedAt: string;
}

export interface InboxQuoteSelectRequest { messageId: number; candidateId: string }
export interface InboxQuoteRequeryRequest { messageId: number; fields: Record<string, string | string[]> }
export interface InboxQuoteDraftResult { subject: string; body: string }

export interface InboxReplyRequest {
  accountId: number;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  attachments?: Array<{ filename: string; contentType?: string; dataBase64: string }>;
}

export interface InboxReplyResult {
  messageId: string;
  sentAt: string;
  localId: number | null;
}

export const INBOX_EVENTS = {
  ANALYSIS_UPDATED: 'inbox:analysisUpdated',
} as const;
