import { beforeAll, describe, expect, it, vi } from "vitest";
import { buildQuotePrompt, buildMailBriefPrompt, stashDevLetterPreset, takeDevLetterPreset } from "../../src/renderer/lib/homeCards";
import { canPickForSending } from "../../src/renderer/pages/campaigns/ContactPicker";

// ═══════════════════════════════════════════════════════════════════
// 首页功能卡片（docs/home-cards-spec.md）：
// 运价查询卡片的标准化提示词是"确保输出标准化"的一半——另一半在 quote_search 服务端。
// 钉住流程四步（quote_search → 航线归属 → 分层报数 → 诚实定论）与用户输入的转义。
// ═══════════════════════════════════════════════════════════════════

describe("运价查询卡片：规范化提示词", () => {
  it("包含用户输入与固定流程四步，目的港必填", () => {
    const p = buildQuotePrompt({ pol: "蛇口", pod: "SANTOS", container: "40HQ", remark: "重点看最低价" });
    expect(p).toContain("起运港：蛇口");
    expect(p).toContain("目的港：SANTOS");
    expect(p).toContain("柜型：40HQ");
    expect(p).toContain('pol="蛇口"');
    expect(p).toContain('pod="SANTOS"');
    expect(p).toContain("先说明目的港属于哪条航线");
    expect(p).toContain("本港专属价在前");
    expect(p).toContain("区分「有过期价」与「真没有」");
    expect(p).toContain("重点看最低价");
  });

  it("可空字段不出现；备注缺失时没有第五步", () => {
    const p = buildQuotePrompt({ pod: "SANTOS" });
    expect(p).toContain("起运港：不限");
    expect(p).not.toContain("柜型：");
    expect(p).not.toContain("用户备注：");
  });

  it("用户输入里的换行/引号原样进提示词但不破坏结构（安全靠 quote_search 参数钳制兜底）", () => {
    const p = buildQuotePrompt({ pod: "SAN'TOS", remark: "a\nb" });
    expect(p).toContain("SAN'TOS");
    expect(p.split("\n").length).toBeGreaterThan(4);
  });
});

describe("自动开发信名单交接（localStorage 一次性）", () => {
  beforeAll(() => {
    // node 测试环境没有 localStorage：装一个内存桩（renderer 里是真实 localStorage）
    const mem = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    });
  });
  it("存进去、读走即删；坏数据当没有", () => {
    stashDevLetterPreset([1, 2, 3], "测试来源");
    const p = takeDevLetterPreset();
    expect(p).toEqual({ ids: [1, 2, 3], note: "测试来源", centerRefs: [] });
    expect(takeDevLetterPreset()).toBeNull();                  // 一次性：第二次读为空

    localStorage.setItem("dev-letter-preset", "{broken");
    expect(takeDevLetterPreset()).toBeNull();
    localStorage.removeItem("dev-letter-preset");
  });

  it("中心推荐会一并保留联系人引用，并且只接受完整引用", () => {
    stashDevLetterPreset([7], "中心来源", [{ contactId: 7, customerId: "customer-7" }]);
    expect(takeDevLetterPreset()).toEqual({
      ids: [7], note: "中心来源", centerRefs: [{ contactId: 7, customerId: "customer-7" }],
    });
    localStorage.setItem("dev-letter-preset", JSON.stringify({
      ids: [8], centerRefs: [{ contactId: 8 }],
    }));
    expect(takeDevLetterPreset()?.centerRefs).toEqual([]);
  });
});

describe("发送任务选人权限", () => {
  const row = (patch: Record<string, unknown>) => ({
    id: 1, email: "buyer@example.invalid", centerReference: { contactId: 1, customerId: "customer-1" }, ...patch,
  });

  it("可发信与可跟进分离时仍允许选取，并优先使用明确发信权限", () => {
    expect(canPickForSending(row({ canFollowup: false, canSendMail: true }) as never)).toBe(true);
    expect(canPickForSending(row({ canFollowup: true, canSendMail: false }) as never)).toBe(false);
    expect(canPickForSending(row({ isShared: true, canFollowup: true }) as never)).toBe(false);
  });
});

describe("今日邮箱概览：让助手逐封看的提示词", () => {
  it("写死流程与红线：先 inbox_search、要正文再读全文、不得自动发送", () => {
    const p = buildMailBriefPrompt();
    expect(p).toContain("inbox_search");
    expect(p).toContain("email_read_full");
    expect(p).toContain("别拿预览当全文");
    expect(p).toContain("不得自动发送");
    expect(p.split("\n").length).toBeGreaterThanOrEqual(4);
  });
});
