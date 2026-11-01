import type { CrmRole } from './auth';
import type { Result } from './crm';

export const SALES_PERFORMANCE_ROUTES = {
  performance: '/api/crm/sales-performance',
  customerGrades: '/api/crm/sales-performance/customer-grades',
} as const;

export const SALES_PERFORMANCE_LIMITS = {
  page: 25,
  pageMax: 100,
  defaultWindowDays: 90,
  maximumWindowDays: 730,
  text: 200,
  reason: 1000,
  key: 128,
  bodyBytes: 8192,
} as const;

export const SALES_PERFORMANCE_MIN_SAMPLES = {
  duration: 5,
  repeatRate: 5,
} as const;

export const SALES_PERFORMANCE_STRATA = ['lead', 'source', 'batch', 'country'] as const;
export type SalesPerformanceStratum = typeof SALES_PERFORMANCE_STRATA[number];
export type SalesPerformanceScope = 'self' | 'leader' | 'operations' | 'superadmin';

export const CUSTOMER_GRADES = ['A', 'B', 'C'] as const;
export type CustomerGrade = typeof CUSTOMER_GRADES[number];

/** Grades are deterministic decisions, not persisted scores. */
export const CUSTOMER_GRADE_THRESHOLDS = {
  gradeAWonOpportunities: 1,
  gradeAValidReplies: 3,
  gradeBValidReplies: 1,
  gradeBOpenOpportunities: 1,
} as const;

export interface DurationMetric {
  sampleCount: number;
  minimumSampleSize: number;
  sufficient: boolean;
  medianSeconds: number | null;
  p90Seconds: number | null;
}

export interface SalesRateMetric {
  count: number;
  total: number;
  rate: number | null;
  sampleCount: number;
  minimumSampleSize: number;
  sufficient: boolean;
}

export interface RepurchaseMetric {
  repeatPurchaseCount: number;
  repeatPurchaseCustomers: number;
  wonCustomers: number;
  rate: SalesRateMetric;
}

export interface SalesPerformanceMetrics {
  claimToFirstAction: DurationMetric;
  claimToValidReply: DurationMetric;
  claimToWon: DurationMetric;
  repeatPurchase: RepurchaseMetric;
}

export interface SalesPerformanceRow {
  key: string;
  label: string;
  memberUserId: string | null;
  memberName: string | null;
  teamId: string | null;
  teamName: string | null;
  claimCount: number;
  customerCount: number;
  completedTaskCount: number;
  validReplyCount: number;
  wonOpportunityCount: number;
  metrics: SalesPerformanceMetrics;
}

export interface SalesPerformanceWindow {
  from: string;
  to: string;
}

export interface SalesPerformanceQuery {
  from: string;
  to: string;
  groupBy: SalesPerformanceStratum;
  teamId?: string;
  memberUserId?: string;
  source?: string;
  batchId?: string;
  country?: string;
  limit: number;
  offset: number;
}

export interface SalesPerformanceOverview {
  scope: SalesPerformanceScope;
  generatedAt: string;
  window: SalesPerformanceWindow;
  groupBy: SalesPerformanceStratum;
  items: SalesPerformanceRow[];
  total: number;
}

export interface CustomerGradeSignals {
  validReplyCount: number;
  wonOpportunityCount: number;
  repeatPurchaseCount: number;
  openOpportunityCount: number;
}

export interface CustomerGradeOverride {
  customerId: string;
  grade: CustomerGrade;
  reason: string;
  actorId: string;
  actorName: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerGradeItem {
  customerId: string;
  companyName: string;
  ownerUserId: string | null;
  ownerName: string | null;
  teamId: string | null;
  teamName: string | null;
  origin: 'personal' | 'operations';
  computedGrade: CustomerGrade;
  effectiveGrade: CustomerGrade;
  source: 'computed' | 'manual';
  reasons: string[];
  signals: CustomerGradeSignals;
  override: CustomerGradeOverride | null;
}

export interface CustomerGradeQuery {
  from: string;
  to: string;
  customerId?: string;
  teamId?: string;
  memberUserId?: string;
  limit: number;
  offset: number;
}

export interface CustomerGradePage {
  scope: SalesPerformanceScope;
  generatedAt: string;
  window: SalesPerformanceWindow;
  thresholds: typeof CUSTOMER_GRADE_THRESHOLDS;
  items: CustomerGradeItem[];
  total: number;
}

export interface CustomerGradeOverrideSet {
  customerId: string;
  expectedVersion: number;
  grade: CustomerGrade;
  reason: string;
  idempotencyKey: string;
}

export interface CustomerGradeOverrideClear {
  customerId: string;
  expectedVersion: number;
  reason: string;
  idempotencyKey: string;
}

export interface CustomerGradeOverrideReceipt {
  customerId: string;
  override: CustomerGradeOverride | null;
}

export interface SalesPerformanceRepository {
  performance(tokenHash: string, query: SalesPerformanceQuery): Promise<Result<SalesPerformanceOverview>>;
  customerGrades(tokenHash: string, query: CustomerGradeQuery): Promise<Result<CustomerGradePage>>;
  setCustomerGradeOverride(tokenHash: string, input: CustomerGradeOverrideSet): Promise<Result<CustomerGradeOverrideReceipt>>;
  clearCustomerGradeOverride(tokenHash: string, input: CustomerGradeOverrideClear): Promise<Result<CustomerGradeOverrideReceipt>>;
}

export function customerGradeScopeFor(input: {
  identityAdmin: boolean;
  roles: readonly CrmRole[];
  isLeader: boolean;
}): SalesPerformanceScope | null {
  if (input.identityAdmin || input.roles.includes('admin')) return 'superadmin';
  if (input.roles.includes('operations')) return 'operations';
  if (input.roles.includes('sales')) return input.isLeader ? 'leader' : 'self';
  return null;
}

/** Initial rollout: aggregate performance is restricted to administrators and above. */
export function salesPerformanceScopeFor(input: {
  identityAdmin: boolean;
  roles: readonly CrmRole[];
  isLeader: boolean;
}): SalesPerformanceScope | null {
  const scope = customerGradeScopeFor(input);
  return scope === 'superadmin' || scope === 'operations' ? scope : null;
}

function rounded(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Linear interpolation matches PostgreSQL percentile_cont. */
export function percentile(values: readonly number[], fraction: number): number | null {
  if (!values.length || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position), upper = Math.ceil(position);
  if (lower === upper) return rounded(sorted[lower]!);
  const weight = position - lower;
  return rounded(sorted[lower]! * (1 - weight) + sorted[upper]! * weight);
}

export function durationMetric(values: readonly number[], minimumSampleSize = SALES_PERFORMANCE_MIN_SAMPLES.duration): DurationMetric {
  const samples = values.filter(value => Number.isFinite(value) && value >= 0);
  return {
    sampleCount: samples.length,
    minimumSampleSize,
    sufficient: samples.length >= minimumSampleSize,
    medianSeconds: percentile(samples, 0.5),
    p90Seconds: percentile(samples, 0.9),
  };
}

export function salesRateMetric(
  count: number,
  total: number,
  minimumSampleSize = SALES_PERFORMANCE_MIN_SAMPLES.repeatRate,
): SalesRateMetric {
  const safeCount = Math.max(0, count), safeTotal = Math.max(0, total);
  return {
    count: safeCount,
    total: safeTotal,
    rate: safeTotal ? rounded(safeCount / safeTotal) : null,
    sampleCount: safeTotal,
    minimumSampleSize,
    sufficient: safeTotal >= minimumSampleSize,
  };
}

export function customerGradeFor(signals: CustomerGradeSignals): { grade: CustomerGrade; reasons: string[] } {
  if (signals.wonOpportunityCount >= CUSTOMER_GRADE_THRESHOLDS.gradeAWonOpportunities) {
    return { grade: 'A', reasons: ['won_opportunity'] };
  }
  if (signals.validReplyCount >= CUSTOMER_GRADE_THRESHOLDS.gradeAValidReplies) {
    return { grade: 'A', reasons: ['three_valid_replies'] };
  }
  if (signals.validReplyCount >= CUSTOMER_GRADE_THRESHOLDS.gradeBValidReplies) {
    return { grade: 'B', reasons: ['valid_reply'] };
  }
  if (signals.openOpportunityCount >= CUSTOMER_GRADE_THRESHOLDS.gradeBOpenOpportunities) {
    return { grade: 'B', reasons: ['open_opportunity'] };
  }
  return { grade: 'C', reasons: ['insufficient_customer_signal'] };
}
