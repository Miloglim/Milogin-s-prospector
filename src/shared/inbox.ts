/** 深链邮件可超出列表分类上限；仅附带目标行，不扩大常规列表。 */
export interface InboxListRequest { includeId?: number; centerMessageKey?: string }

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

export interface InboxTodoBatchRequest {
  messageIds: number[];
  state: InboxTodoState;
  idempotencyKey: string;
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
  source: 'rule' | 'ai' | 'human';
  analyzerVersion: string;
  status: 'pending' | 'ready' | 'failed';
  error: string | null;
  updatedAt: string;
}

export interface InboxAnalysisStatus {
  enabled: boolean;
  pending: number;
  ready: number;
  failed: number;
}

export const INBOX_EVENTS = {
  ANALYSIS_UPDATED: 'inbox:analysisUpdated',
} as const;
