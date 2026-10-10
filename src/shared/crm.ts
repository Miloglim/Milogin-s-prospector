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
