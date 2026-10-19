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
