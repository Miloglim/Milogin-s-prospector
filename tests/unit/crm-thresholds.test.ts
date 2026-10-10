import { expect, it } from "vitest";
import { normalizeCrmThresholds } from "../../src/shared/crm";
it("缺失、0、NaN、负数和错误类型均回默认；预警不晚于逾期", () => {
  for (const value of [undefined, 0, NaN, -1, "7", Infinity, 1.5]) {
    expect(normalizeCrmThresholds({ silentOverdueDays: value, warnDays: value })).toEqual({ overdueDays: 5, warnDays: 3 });
  }
  expect(normalizeCrmThresholds({ silentOverdueDays: 7, warnDays: 4 })).toEqual({ overdueDays: 7, warnDays: 4 });
  expect(normalizeCrmThresholds({ silentOverdueDays: 2 })).toEqual({ overdueDays: 2, warnDays: 2 });
});
