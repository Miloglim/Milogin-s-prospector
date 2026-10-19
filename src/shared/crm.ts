export const DEFAULT_CRM_OVERDUE_DAYS = 5;
export const DEFAULT_CRM_WARN_DAYS = 3;
export const MAX_CRM_THRESHOLD_DAYS = 365;
export interface CrmThresholds { overdueDays: number; warnDays: number }
export function normalizeCrmThresholds(crm?: { silentOverdueDays?: unknown; warnDays?: unknown }): CrmThresholds {
  const valid = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_CRM_THRESHOLD_DAYS;
  const overdueDays = valid(crm?.silentOverdueDays) ? crm.silentOverdueDays : DEFAULT_CRM_OVERDUE_DAYS;
  const warnDays = Math.min(valid(crm?.warnDays) ? crm.warnDays : DEFAULT_CRM_WARN_DAYS, overdueDays);
  return { overdueDays, warnDays };
}

const DAY_MS = 86_400_000;
/** Contact silence never resets on an unrelated edit or a stage-only note. */
export function contactFollowupAge(lastAt: string | null, now: number, crm?: { silentOverdueDays?: unknown; warnDays?: unknown }) {
  const thresholds = normalizeCrmThresholds(crm);
  const timestamp = lastAt ? Date.parse(lastAt) : NaN;
  const staleDays = Number.isFinite(timestamp) ? Math.max(0, Math.floor((now - timestamp) / DAY_MS)) : null;
  return { ...thresholds, staleDays, overdue: staleDays !== null && staleDays > thresholds.overdueDays };
}
