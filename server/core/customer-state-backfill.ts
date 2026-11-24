import { customerStatusIsRegression, type CustomerStatus } from './customer-status';

export interface CustomerStatusBackfillSignal {
  key: string;
  occurredAt: string;
  proposedStatus: CustomerStatus;
  source: 'activity' | 'mail' | 'opportunity' | 'case' | 'ai';
  sourceId: string;
  evidence: unknown[];
  payload: Record<string, unknown>;
  allowRegression?: boolean;
}

export interface CustomerStatusBackfillEvent {
  key: string;
  occurredAt: string;
  status: CustomerStatus;
  previousStatus: CustomerStatus;
  source: CustomerStatusBackfillSignal['source'];
  sourceId: string;
  evidence: unknown[];
  payload: Record<string, unknown>;
}

export interface CustomerStatusBackfillPlan {
  events: CustomerStatusBackfillEvent[];
  finalStatus: CustomerStatus;
  skipped: number;
}

export function planCustomerStatusBackfill(signals: readonly CustomerStatusBackfillSignal[], initialStatus: CustomerStatus = 'uncontacted'): CustomerStatusBackfillPlan {
  const ordered = [...signals].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.key.localeCompare(right.key));
  let status = initialStatus;
  let skipped = 0;
  const events: CustomerStatusBackfillEvent[] = [];
  for (const signal of ordered) {
    if (signal.proposedStatus === status || !signal.allowRegression && customerStatusIsRegression(status, signal.proposedStatus)) {
      skipped++;
      continue;
    }
    events.push({ key: signal.key, occurredAt: signal.occurredAt, status: signal.proposedStatus, previousStatus: status, source: signal.source, sourceId: signal.sourceId, evidence: signal.evidence, payload: signal.payload });
    status = signal.proposedStatus;
  }
  return { events, finalStatus: status, skipped };
}
