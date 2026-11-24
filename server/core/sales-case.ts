export const SALES_CASE_STATES = [
  'lead_pending', 'lead_verified', 'outreach_ready', 'outreach_running', 'awaiting_reply',
  'replied', 'inquiry_detected', 'quote_preparing', 'quote_review', 'quote_sent',
  'negotiating', 'won', 'lost', 'paused',
] as const;
export type SalesCaseState = typeof SALES_CASE_STATES[number];

export const SALES_CASE_TERMINAL_STATES: ReadonlySet<SalesCaseState> = new Set(['won', 'lost']);

export const SALES_CASE_EVENT_TYPES = [
  'lead.verified', 'campaign.proposed', 'campaign.confirmed', 'campaign.started', 'mail.sent',
  'reply.received', 'mail.bounced', 'mail.unsubscribed', 'inquiry.detected', 'quote.requested',
  'quote.confirmed', 'quote.rejected', 'case.paused', 'case.won', 'case.lost',
  'proposal.applied', 'proposal.accepted', 'proposal.edited', 'proposal.ignored', 'proposal.cancelled',
] as const;
export type SalesCaseEventType = typeof SALES_CASE_EVENT_TYPES[number];

export const AI_PROPOSAL_TYPES = ['campaign_draft', 'reply_draft', 'quote_draft', 'followup', 'deal_won'] as const;
export type AiProposalType = typeof AI_PROPOSAL_TYPES[number];

export const AI_PROPOSAL_STATES = ['pending', 'applied_pending_confirmation', 'accepted', 'edited', 'ignored', 'cancelled', 'expired', 'blocked'] as const;
export type AiProposalState = typeof AI_PROPOSAL_STATES[number];

export const AI_PROPOSAL_ACTIONS = ['accept', 'edit', 'ignore', 'cancel'] as const;
export type AiProposalAction = typeof AI_PROPOSAL_ACTIONS[number];

export const DEAL_WON_EVENT = 'crm.ai.deal_won' as const;
export const DEAL_WON_INTENTS = ['contract_signed', 'booking_confirmed', 'deal_won'] as const;

export interface CreateAiProposalInput {
  proposalType: AiProposalType;
  payload: Record<string, unknown>;
  evidence?: unknown[];
  confidence: number;
  model?: string | null;
  version?: string | null;
  expiresAt?: string | null;
}

export interface ActAiProposalInput {
  action: AiProposalAction;
  payload?: Record<string, unknown>;
}

export interface SalesCase {
  caseId: string;
  customerId: string;
  contactId: number;
  ownerUserId: string;
  state: SalesCaseState;
  source: string;
  verifiedAt: string | null;
  latestMessageKey: string | null;
  latestSummary: string | null;
  nextAction: string | null;
  nextActionAt: string | null;
  stopReason: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface SalesCaseEvent {
  eventId: number;
  caseId: string;
  eventKey: string;
  eventType: SalesCaseEventType;
  source: 'rule' | 'ai' | 'user' | 'system';
  payload: Record<string, unknown>;
  evidence: unknown[];
  actorUserId: string | null;
  createdAt: string;
}

export interface AiProposal {
  proposalId: string;
  caseId: string;
  proposalType: AiProposalType;
  status: AiProposalState;
  payload: Record<string, unknown>;
  evidence: unknown[];
  confidence: number;
  model: string | null;
  version: string | null;
  expiresAt: string | null;
  actedBy: string | null;
  actedAt: string | null;
  createdAt: string;
}

export interface SalesCaseDetail {
  case: SalesCase;
  events: SalesCaseEvent[];
  proposals: AiProposal[];
}

const TRANSITIONS: Record<SalesCaseState, readonly SalesCaseState[]> = {
  lead_pending: ['lead_verified', 'paused', 'lost'],
  lead_verified: ['outreach_ready', 'inquiry_detected', 'paused', 'lost'],
  outreach_ready: ['outreach_running', 'inquiry_detected', 'paused', 'lost'],
  outreach_running: ['awaiting_reply', 'replied', 'paused', 'lost'],
  awaiting_reply: ['replied', 'paused', 'lost'],
  replied: ['inquiry_detected', 'negotiating', 'won', 'lost', 'paused'],
  inquiry_detected: ['quote_preparing', 'paused', 'lost'],
  quote_preparing: ['quote_review', 'quote_sent', 'paused', 'lost'],
  quote_review: ['quote_sent', 'paused', 'lost'],
  quote_sent: ['negotiating', 'won', 'lost', 'paused'],
  negotiating: ['quote_preparing', 'quote_review', 'won', 'lost', 'paused'],
  won: [],
  lost: [],
  paused: ['lead_verified', 'outreach_ready', 'awaiting_reply', 'replied', 'quote_preparing', 'lost'],
};

export function canTransitionSalesCase(from: SalesCaseState, to: SalesCaseState): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function isSalesCaseTerminal(state: SalesCaseState): boolean {
  return SALES_CASE_TERMINAL_STATES.has(state);
}

export function salesCaseStopReason(kind: 'reply' | 'bounce' | 'unsubscribe' | 'complaint'): string | null {
  if (kind === 'reply') return 'customer_replied';
  if (kind === 'bounce') return 'mail_bounced';
  if (kind === 'unsubscribe') return 'unsubscribed';
  if (kind === 'complaint') return 'complaint';
  return null;
}

export function nextSalesCaseAction(item: Pick<SalesCase, 'state' | 'nextAction'>): string | null {
  if (item.nextAction) return item.nextAction;
  switch (item.state) {
    case 'lead_pending': return '验证线索';
    case 'lead_verified': return '准备客户开发任务';
    case 'outreach_ready': return '确认开发任务';
    case 'outreach_running': return '等待客户回复';
    case 'awaiting_reply': return '等待客户回复';
    case 'replied': return '判断客户反馈';
    case 'inquiry_detected': return '提取运输需求';
    case 'quote_preparing': return '确认报价草稿';
    case 'quote_review': return '等待主管审核';
    case 'quote_sent': return '跟进客户反馈';
    case 'negotiating': return '继续协商';
    default: return null;
  }
}

export function canActOnProposal(state: AiProposalState): boolean {
  return state === 'pending' || state === 'applied_pending_confirmation';
}

export function proposalActionState(action: AiProposalAction): AiProposalState {
  if (action === 'accept') return 'accepted';
  if (action === 'edit') return 'edited';
  if (action === 'cancel') return 'cancelled';
  return 'ignored';
}
