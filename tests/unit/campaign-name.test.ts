import { describe, expect, it } from "vitest";
import { nextCampaignName } from "../../src/shared/campaign-name";

describe("default campaign names", () => {
  it("starts at task 1 for an empty campaign list", () => {
    expect(nextCampaignName([])).toBe("任务1");
  });

  it("uses the first available positive suffix without duplicating existing tasks", () => {
    expect(nextCampaignName(["任务1", "任务3"])).toBe("任务2");
  });

  it("ignores custom task names", () => {
    expect(nextCampaignName(["巴西冷客户", " 任务1 "])).toBe("任务2");
  });
});
