import type { Result } from './crm';
import type {
  MailIntentCode,
  MailPriority,
  MailRelevance,
  MailAnalysisSource,
} from './mail-analysis';
import type { MailClassification } from './contact-mail';

export const TEAM_ATTENTION_ROUTES = {
  items: '/api/crm/team-attention',
} as const;

export const TEAM_ATTENTION_LIMITS = {
  note: 2000,
  result: 5000,
  key: 128,
  page: 25,
  pageMax: 100,
  bodyBytes: 16384,
} as const;

export const TEAM_ATTENTION_REASONS = [
  'important_reply',
  'quote_overdue',
  'unhandled_inquiry',
  'bounce_correction',
] as const;
export type TeamAttentionReason = typeof TEAM_ATTENTION_REASONS[number];

export const TEAM_ATTENTION_STATUSES = ['open', 'acknowledged', 'resolved', 'dismissed'] as const;
export type TeamAttentionStatus = typeof TEAM_ATTENTION_STATUSES[number];
export type TeamAttentionScope = 'member' | 'supervisor' | 'oversight';
export type TeamAttentionTransitionAction = 'acknowledge' | 'dismiss' | 'resolve';

export const TEAM_ATTENTION_EVENTS = {
  opened: 'crm.team.attention.opened',
  acknowledged: 'crm.team.attention.acknowledged',
  resolved: 'crm.team.attention.resolved',
  dismissed: 'crm.team.attention.dismissed',
} as const;

export interface TeamAttentionItem {
  itemId: string;
  targetMemberUserId: string;
  targetMemberName: string;
  sourceSupervisorUserId: string;
  sourceSupervisorName: string;
  customerId: string;
  customerName: string;
  contactId: number;
  contactName: string;
  contactEmail: string | null;
  mailEventId: string | null;
  analysisId: string | null;
  reason: TeamAttentionReason;
  priority: MailPriority;
  status: TeamAttentionStatus;
  note: string | null;
  result: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  dismissedAt: string | null;
  canAcknowledge: boolean;
  canDismiss: boolean;
  canResolve: boolean;
}

export interface TeamAttentionCounts {
  open: number;
  acknowledged: number;
  resolved: number;
  dismissed: number;
}

export interface TeamAttentionPage {
  scope: TeamAttentionScope;
  items: TeamAttentionItem[];
  total: number;
  counts: TeamAttentionCounts;
}

export interface TeamAttentionQuery {
  status?: TeamAttentionStatus;
  reason?: TeamAttentionReason;
  targetMemberUserId?: string;
  limit: number;
  offset: number;
}

export interface TeamAttentionCreate {
  targetMemberUserId: string;
  customerId: string;
  contactId: number;
  mailEventId?: string;
  analysisId?: string;
  reason: TeamAttentionReason;
  priority: MailPriority;
  note?: string;
  idempotencyKey: string;
}

export interface TeamAttentionTransition {
  itemId: string;
  action: TeamAttentionTransitionAction;
  expectedVersion: number;
  idempotencyKey: string;
  result?: string;
}

export interface TeamAttentionRepository {
  list(tokenHash: string, query: TeamAttentionQuery): Promise<Result<TeamAttentionPage>>;
  create(tokenHash: string, input: TeamAttentionCreate): Promise<Result<TeamAttentionItem>>;
  transition(tokenHash: string, input: TeamAttentionTransition): Promise<Result<TeamAttentionItem>>;
}

export interface MailTaskAdmissionInput {
  relevance: MailRelevance;
  classification: MailClassification;
  source: MailAnalysisSource;
  confidence: number;
  requiresAction: boolean;
  nextAction: string | null;
  signals: ReadonlyArray<{ code: MailIntentCode; confidence: number }>;
}

export type MailTaskAdmission = 'create' | 'suggest' | 'none';

const AUTO_TASK_CONFIDENCE = 0.85;
const STRONG_TASK_ACTIONS = new Set<MailIntentCode>([
  'price_inquiry',
  'quote_request',
  'complaint',
  'order_followup',
]);

/**
 * Mail analysis always produces a suggestion when customer action is needed.
 * Only fixed, high-signal actions cross the automatic task gate without a human.
 */
export function mailTaskAdmissionFor(input: MailTaskAdmissionInput): MailTaskAdmission {
  if (input.relevance !== 'customer_business' || !input.requiresAction || !input.nextAction?.trim()) return 'none';
  if (input.source === 'human') return 'create';
  const signal = input.signals[0];
  const strong = input.classification === 'bounced' || !!signal && STRONG_TASK_ACTIONS.has(signal.code);
  return strong && input.confidence >= AUTO_TASK_CONFIDENCE && (signal?.confidence ?? input.confidence) >= AUTO_TASK_CONFIDENCE
    ? 'create'
    : 'suggest';
}

export function canTransitionTeamAttention(
  status: TeamAttentionStatus,
  action: TeamAttentionTransitionAction,
): boolean {
  if (status === 'resolved' || status === 'dismissed') return false;
  if (action === 'acknowledge') return status === 'open';
  return status === 'open' || status === 'acknowledged';
}

export function attentionEventFor(status: TeamAttentionStatus): string {
  if (status === 'acknowledged') return TEAM_ATTENTION_EVENTS.acknowledged;
  if (status === 'resolved') return TEAM_ATTENTION_EVENTS.resolved;
  if (status === 'dismissed') return TEAM_ATTENTION_EVENTS.dismissed;
  return TEAM_ATTENTION_EVENTS.opened;
}
