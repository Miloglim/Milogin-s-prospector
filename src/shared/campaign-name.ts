export const DEFAULT_CAMPAIGN_NAME_PREFIX = "任务";

/** Uses the first positive suffix not currently occupied by an exact default name. */
export function nextCampaignName(existingNames: readonly string[]): string {
  const used = new Set(existingNames.map(name => name.trim()));
  for (let suffix = 1; ; suffix += 1) {
    const candidate = `${DEFAULT_CAMPAIGN_NAME_PREFIX}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}
