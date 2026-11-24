import { customerJourneyView, type CustomerJourneyState } from './customer-state';

export const CUSTOMER_STATUSES = ['uncontacted', 'contacted', 'replied', 'quoting', 'negotiating', 'won_pending', 'won', 'lost'] as const;
export type CustomerStatus = typeof CUSTOMER_STATUSES[number];
const CUSTOMER_STATUS_RANK: Record<Exclude<CustomerStatus, 'lost'>, number> = {
  uncontacted: 0, contacted: 1, replied: 2, quoting: 3, negotiating: 4, won_pending: 5, won: 6,
};

export const CUSTOMER_STATUS_SOURCES = ['ai', 'human', 'system', 'import'] as const;
export type CustomerStatusSource = typeof CUSTOMER_STATUS_SOURCES[number];

export const CUSTOMER_STATUS_SIGNALS = ['followup', 'mail', 'deal_won', 'opportunity', 'sales_case', 'correction', 'ai_resume', 'import'] as const;
export type CustomerStatusSignal = typeof CUSTOMER_STATUS_SIGNALS[number];
export const CUSTOMER_STATUS_LIMITS = { events: 50, reason: 1000, key: 128, text: 500 } as const;
export const CUSTOMER_STATUS_ROUTES = { base: '/api/crm/customer-status' } as const;

export interface CustomerStatusEventInput {
  eventKey: string;
  customerId: string;
  contactId?: number | null;
  status: CustomerStatus;
  previousStatus?: CustomerStatus | null;
  source: CustomerStatusSource;
  signal: CustomerStatusSignal;
  actorUserId?: string | null;
  reason?: string | null;
  evidence?: unknown[];
  payload?: Record<string, unknown>;
  occurredAt: Date | string;
  recordWhenUnchanged?: boolean;
}

export interface CustomerStatusEvent {
  eventId: number;
  eventKey: string;
  customerId: string;
  contactId: number | null;
  status: CustomerStatus;
  previousStatus: CustomerStatus | null;
  source: CustomerStatusSource;
  signal: CustomerStatusSignal;
  actorUserId: string | null;
  reason: string | null;
  evidence: unknown[];
  payload: Record<string, unknown>;
  occurredAt: string;
  recordedAt: string;
}

export interface CustomerStatusChangeInput {
  relationshipStage?: string | null;
  touchStatuses?: ReadonlyArray<string | null | undefined>;
  aiDealPending?: boolean;
  nextRelationshipStage?: string | null;
  nextTouchStatus?: string | null;
  /** Human corrections may move backward only when the user explicitly chooses that path. */
  allowRegression?: boolean;
}

export interface CustomerStatusChange {
  before: CustomerJourneyState;
  after: CustomerJourneyState;
  changed: boolean;
}

export interface CustomerStatusState {
  customerId: string;
  status: CustomerStatus;
  previousStatus: CustomerStatus | null;
  source: CustomerStatusSource;
  signal: CustomerStatusSignal;
  contactId: number | null;
  actorUserId: string | null;
  reason: string | null;
  occurredAt: string;
  updatedAt: string;
  manualLocked: boolean;
  manualReason: string | null;
  manualBy: string | null;
  manualAt: string | null;
  version: number;
}

export interface CustomerStatusView {
  state: CustomerStatusState | null;
  events: CustomerStatusEvent[];
}

export interface CustomerStatusCorrection {
  customerId: string;
  contactId?: number | null;
  expectedVersion: number;
  status: CustomerStatus;
  reason: string;
  idempotencyKey: string;
}

export interface CustomerStatusResume {
  customerId: string;
  expectedVersion: number;
  idempotencyKey: string;
}

export function opportunityCustomerStatus(stage: string): CustomerStatus | null {
  if (stage === 'inquiry' || stage === 'quote_sent') return 'quoting';
  if (stage === 'negotiation') return 'negotiating';
  if (stage === 'booking_confirmed') return 'won_pending';
  if (stage === 'closed_won') return 'won';
  if (stage === 'closed_lost') return 'lost';
  return null;
}

export function salesCaseCustomerStatus(state: string): CustomerStatus | null {
  if (state === 'replied') return 'replied';
  if (state === 'inquiry_detected' || state === 'quote_preparing' || state === 'quote_review' || state === 'quote_sent') return 'quoting';
  if (state === 'negotiating') return 'negotiating';
  if (state === 'won') return 'won';
  if (state === 'lost') return 'lost';
  return null;
}

/** Resolve one write against the same precedence used by the visible state chain. */
export function customerStatusChange(input: CustomerStatusChangeInput): CustomerStatusChange {
  const before = customerJourneyView({
    relationshipStage: input.relationshipStage,
    touchStatuses: input.touchStatuses,
    aiDealPending: input.aiDealPending,
  }).state;
  let after = customerJourneyView({
    relationshipStage: input.nextRelationshipStage === undefined ? input.relationshipStage : input.nextRelationshipStage,
    touchStatuses: input.nextTouchStatus === undefined ? input.touchStatuses : [input.nextTouchStatus],
    aiDealPending: input.aiDealPending,
  }).state;
  if (!input.allowRegression && customerStatusIsRegression(before, after)) after = before;
  return { before, after, changed: before !== after };
}

export function customerStatusIsRegression(from: CustomerJourneyState, to: CustomerJourneyState): boolean {
  if (from === to) return false;
  if (from === 'lost') return true;
  if (to === 'lost') return false;
  return CUSTOMER_STATUS_RANK[to] < CUSTOMER_STATUS_RANK[from];
}

export function customerStatusRank(status: CustomerStatus): number {
  return status === 'lost' ? 100 : CUSTOMER_STATUS_RANK[status];
}

export function highestCustomerStatus(statuses: readonly (CustomerStatus | null | undefined)[]): CustomerStatus | null {
  let result: CustomerStatus | null = null;
  for (const status of statuses) if (status && (!result || customerStatusRank(status) > customerStatusRank(result))) result = status;
  return result;
}
