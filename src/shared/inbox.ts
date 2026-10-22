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
  message?: string;
}
