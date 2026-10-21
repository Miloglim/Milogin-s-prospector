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
  levelProgress: number;
  levelCost: number;
  todayXp: number;
  todayKey: string | null;
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
  return { totalXp: total, cycle, level, levelProgress: withinCycle - levelStartInCycle, levelCost, todayXp: Math.max(0, Math.trunc(todayXp)), todayKey };
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
