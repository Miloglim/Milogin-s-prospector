export const ASSISTANT_CHANNELS = {
  SNAPSHOT: 'assistant:snapshot',
  QUEUE: 'assistant:queue',
  RUN: 'assistant:run',
  DISMISS: 'assistant:dismiss',
  SETTINGS_UPDATE: 'assistant:settingsUpdate',
} as const;

export const ASSISTANT_DEFAULT_INTERVAL_MINUTES = 60;
export const ASSISTANT_INTERVAL_OPTIONS = [30, 60, 120, 240] as const;
export const ASSISTANT_MAX_REMINDERS = 4;

export interface AssistantChecks {
  mail: boolean;
  task: boolean;
  quoteReview: boolean;
  stalled: boolean;
}

export const ASSISTANT_DEFAULT_CHECKS: AssistantChecks = { mail: true, task: true, quoteReview: true, stalled: true };

export interface AssistantSettings {
  enabled: boolean;
  intervalMinutes: number;
  checks: AssistantChecks;
}

export type AssistantReminderSource = 'ai' | 'rule';

export type AssistantReminderKind = 'mail' | 'quote' | 'task' | 'followup';

export interface AssistantReminderFactItem {
  id: string;
  title: string;
  detail: string;
  target: string;
  meta?: string;
}

export interface AssistantReminderFacts {
  messageId?: number;
  quoteCaseId?: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
  senderEmail?: string | null;
  subject?: string | null;
  waitedHours?: number | null;
  lastAction?: string | null;
  analysis?: string | null;
  mailExcerpt?: string | null;
  pol?: string | null;
  pod?: string | null;
  carrier?: string | null;
  containerType?: string | null;
  selectedCandidateId?: string | null;
  price?: number | null;
  currency?: string | null;
  validTo?: string | null;
  fieldSummary?: Array<{ label: string; value: string }>;
  candidates?: Array<{
    id: string; carrier: string | null; pol: string | null; pod: string | null;
    containerType: string | null; price: number | null; currency: string | null; validTo: string | null;
  }>;
  items?: AssistantReminderFactItem[];
  total?: number;
  /** 真实收信时间（邮件、询价、待确认报价），用于把事项分到「逾期 / 今天」 */
  receivedAt?: string | null;
  /** 真实到期时间（中心待办），到点前属于今天，过期属于逾期 */
  dueAt?: string | null;
  earliestDueAt?: string | null;
  maxDays?: number | null;
  overdueCount?: number;
  source?: string | null;
}

export interface AssistantReminder {
  reminderId: string;
  kind?: AssistantReminderKind;
  title: string;
  detail: string;
  /** inbox:<messageId> | customers:<customerId>:<contactId> | team_review */
  target: string;
  priority: 1 | 2 | 3;
  source: AssistantReminderSource;
  createdAt: string;
  facts?: AssistantReminderFacts;
}

export interface AssistantSnapshot {
  reminders: AssistantReminder[];
  settings: AssistantSettings;
  lastCheckedAt: string | null;
  lastError: string | null;
  aiConfigured: boolean;
  due: boolean;
}

export type AssistantRunResult = AssistantSnapshot & { ran: boolean };

/** Short call-to-action shown on the "new conversation" navigation item. */
export function assistantCallout(reminders: readonly AssistantReminder[]): string {
  if (!reminders.length) return '任务';
  const top = [...reminders].sort((left, right) => left.priority - right.priority)[0]!;
  if (top.title.startsWith('客户在等回复：')) {
    const name = top.title.slice(7).trim().slice(0, 6);
    return name ? `回复 ${name}` : '回复客户';
  }
  if (top.title.startsWith('报价待你确认：')) return '确认报价';
  if (top.title.startsWith('待办：')) return '处理待办';
  if (top.title.startsWith('跟进停了')) return '跟进客户';
  return reminders.length > 1 ? `待处理 ${reminders.length}` : '待处理';
}
