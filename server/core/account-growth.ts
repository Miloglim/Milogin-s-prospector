export const GROWTH_SOURCE_PRODUCTS = ["navigator", "crm"] as const;
export type GrowthSourceProduct = typeof GROWTH_SOURCE_PRODUCTS[number];

const MIN_GROWTH_POINTS = 1;
const MIN_RULE_VERSION = 1;

export interface GrowthEventDraft {
  eventId: string;
  userId: string;
  sourceProduct: GrowthSourceProduct;
  eventType: string;
  subjectKey: string;
  points: number;
  ruleVersion: number;
  occurredAt: string;
}

export interface GrowthProjection {
  userId: string;
  totalXp: number;
  cycle: number;
  level: number;
  todayXp: number;
  todayKey: string | null;
}

export interface GrowthSummary {
  totalXp: number;
  cycle: number;
  level: number;
  levelName: string;
  levelStart: number;
  nextThreshold: number;
  levelProgress: number;
  levelCost: number;
  cycleStart: number;
  cycleEnd: number;
  cycleXp: number;
  todayAwarded: boolean;
  todayXp: number;
  todayKey: string | null;
}

export interface GrowthEventInput {
  eventId: string;
  sourceProduct: GrowthSourceProduct;
  eventType: string;
  subjectKey: string;
  points: number;
  ruleVersion: number;
  occurredAt: string;
}

export interface GrowthEventReceipt {
  awarded: boolean;
  awardedPoints: number;
  summary: GrowthSummary;
}

const GROWTH_EVENT_RULES: Readonly<Record<string, { points: number; dailyCap: number | null }>> = {
  daily_quote_search: { points: 2, dailyCap: 30 },
  daily_effective_search: { points: 18, dailyCap: 30 },
  daily_review_activity: { points: 18, dailyCap: 30 },
  pending_approved: { points: 2, dailyCap: null },
  pending_correction_approved: { points: 6, dailyCap: null },
  daily_governance_activity: { points: 6, dailyCap: 30 },
  governance_item_completed: { points: 6, dailyCap: 30 },
};

export function growthEventRule(sourceProduct: GrowthSourceProduct, eventType: string) {
  return sourceProduct === "navigator" ? GROWTH_EVENT_RULES[eventType] ?? null : null;
}

export function isGrowthEventInput(value: unknown): value is GrowthEventInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Partial<GrowthEventInput>;
  return nonEmpty(event.eventId) && event.eventId.length <= 128
    && GROWTH_SOURCE_PRODUCTS.includes(event.sourceProduct as GrowthSourceProduct)
    && nonEmpty(event.eventType) && event.eventType.length <= 80
    && nonEmpty(event.subjectKey) && event.subjectKey.length <= 256
    && Number.isInteger(event.points) && (event.points as number) >= 1 && (event.points as number) <= 1000
    && Number.isInteger(event.ruleVersion) && (event.ruleVersion as number) >= 1
    && typeof event.occurredAt === "string" && !Number.isNaN(Date.parse(event.occurredAt));
}

const GROWTH_LEVELS_PER_CYCLE = 50;
const GROWTH_LEVEL_BASE_XP = 12;
const GROWTH_LEVEL_MAX_XP = 30;

function growthLevelCost(level: number): number {
  const index = Math.max(0, Math.min(GROWTH_LEVELS_PER_CYCLE - 1, level - 1));
  return GROWTH_LEVEL_BASE_XP + Math.floor(index * (GROWTH_LEVEL_MAX_XP - GROWTH_LEVEL_BASE_XP) / (GROWTH_LEVELS_PER_CYCLE - 1));
}

const GROWTH_LEVEL_COSTS = Array.from({ length: GROWTH_LEVELS_PER_CYCLE }, (_, index) => growthLevelCost(index + 1));
const GROWTH_XP_PER_CYCLE = GROWTH_LEVEL_COSTS.reduce((sum, value) => sum + value, 0);

/** Derive display progress from the shared total; the stored level remains a rebuildable projection. */
export function growthSummary(totalXp: number, todayXp = 0, todayKey: string | null = null): GrowthSummary {
  const total = Math.max(0, Math.trunc(totalXp));
  const cycle = Math.floor(total / GROWTH_XP_PER_CYCLE) + 1;
  const withinCycle = total % GROWTH_XP_PER_CYCLE;
  let level = 1;
  let levelStartInCycle = 0;
  for (let candidate = 1; candidate <= GROWTH_LEVELS_PER_CYCLE; candidate++) {
    const cost = growthLevelCost(candidate);
    if (withinCycle < levelStartInCycle + cost) {
      level = candidate;
      break;
    }
    levelStartInCycle += cost;
  }
  const levelCost = growthLevelCost(level);
  const levelProgress = withinCycle - levelStartInCycle;
  const levelStart = (cycle - 1) * GROWTH_XP_PER_CYCLE + levelStartInCycle;
  return {
    totalXp: total, cycle, level, levelName: `第${cycle}循环`, levelStart, nextThreshold: levelStart + levelCost,
    levelProgress, levelCost, cycleStart: (cycle - 1) * GROWTH_XP_PER_CYCLE,
    cycleEnd: cycle * GROWTH_XP_PER_CYCLE, cycleXp: GROWTH_XP_PER_CYCLE,
    todayAwarded: todayXp > 0, todayXp: Math.max(0, Math.trunc(todayXp)), todayKey,
  };
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isGrowthEventDraft(value: unknown): value is GrowthEventDraft {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<GrowthEventDraft>;
  return nonEmpty(event.eventId) && nonEmpty(event.userId) && nonEmpty(event.eventType)
    && nonEmpty(event.subjectKey) && nonEmpty(event.occurredAt)
    && GROWTH_SOURCE_PRODUCTS.includes(event.sourceProduct as GrowthSourceProduct)
    && Number.isInteger(event.points) && (event.points as number) >= MIN_GROWTH_POINTS
    && Number.isInteger(event.ruleVersion) && (event.ruleVersion as number) >= MIN_RULE_VERSION;
}
