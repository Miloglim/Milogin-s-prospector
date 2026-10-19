import type { Result } from './crm';

export const OPPORTUNITY_ROUTES = { opportunities: '/api/crm/opportunities', stageAction: 'stage' } as const;
export const OPPORTUNITY_LIMITS = { title: 500, description: 20000, route: 128, source: 500, evidence: 4096, reason: 2000, key: 128, page: 25, pageMax: 100, amountWholeDigits: 12, amountFractionDigits: 2 } as const;
export const OPPORTUNITY_STAGES = ['inquiry', 'quote_sent', 'negotiation', 'booking_confirmed', 'closed_won', 'closed_lost'] as const;
export type OpportunityStage = typeof OPPORTUNITY_STAGES[number];
export const OPPORTUNITY_STAGE_LABELS: Record<OpportunityStage, string> = { inquiry: '询价', quote_sent: '已报价', negotiation: '谈判中', booking_confirmed: '订舱确认', closed_won: '已成交', closed_lost: '已丢单' };
export const OPPORTUNITY_EVENTS = { created: 'crm.opportunity.created', stageChanged: 'crm.opportunity.stage_changed' } as const;
export interface OpportunityCreate {
  customerId: string; expectedCustomerVersion: number; idempotencyKey: string;
  title: string; description?: string; pol?: string; pod?: string; containerType?: string;
  source?: string; amount?: string; currency?: string;
}
export interface OpportunityUpdateStage {
  opportunityId: string; expectedVersion: number; idempotencyKey: string; stage: OpportunityStage;
  amount?: string; currency?: string; lostReason?: string; evidence?: string;
}
export interface OpportunityQuery { customerId: string; limit: number; offset: number; }
export interface OpportunityHistory {
  historyId: string; fromStage: OpportunityStage | null; toStage: OpportunityStage;
  actorId: string; actorName: string | null; occurredAt: string;
  amount: string | null; currency: string | null; lostReason: string | null; evidence: string | null;
}
export interface Opportunity {
  opportunityId: string; customerId: string; title: string; description: string; pol: string | null; pod: string | null;
  containerType: string | null; source: string; stage: OpportunityStage; amount: string | null; currency: string | null;
  lostReason: string | null; evidence: string | null; version: number; ownerUserId: string; ownerName: string | null;
  createdBy: string; createdAt: string; updatedAt: string; closedAt: string | null; closedBy: string | null;
  canManage: boolean; history: OpportunityHistory[];
}
export interface OpportunityPage { items: Opportunity[]; total: number; }
export interface OpportunityRepository {
  create(hash: string, input: OpportunityCreate): Promise<Result<Opportunity>>;
  list(hash: string, input: OpportunityQuery): Promise<Result<OpportunityPage>>;
  detail(hash: string, id: string): Promise<Result<Opportunity>>;
  updateStage(hash: string, input: OpportunityUpdateStage): Promise<Result<Opportunity>>;
}
