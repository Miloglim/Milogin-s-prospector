/** 深链邮件可超出列表分类上限；仅附带目标行，不扩大常规列表。 */
export interface InboxListRequest { includeId?: number }

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
