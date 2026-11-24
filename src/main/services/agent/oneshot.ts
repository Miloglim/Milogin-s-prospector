// ── 一次性 JSON 解析调用（轻量模型入口）─────────────────────────────────
// 与 runHarnessTurn 的区别：不进会话、不落 transcript、不带工具、不推事件、不要审批。
// 只承担一件事：把用户的一句自然语言翻成结构化参数（首页「自动开发信」的要求输入框）。
// 红线：名单由确定性规则选出（dev-letter.service），模型不决定选谁、也不发任何东西
//       （docs/home-cards-spec.md §5-3 + docs/task-card-devletter-spec.md §4）。
import { chat, isAiConfigured } from "../ai.service";

/** 模型端点是否可用（UI 要如实告诉用户"这次是关键词理解的"） */
export function onceModelReady(): boolean {
  return isAiConfigured();
}

/**
 * 要一段严格 JSON 回来。任何失败（没配端点 / 网络 / 解析不出）一律返回 null，
 * 由调用方走确定性兜底——绝不因为"模型没听懂"就把用户的整条要求丢掉。
 */
export async function askJsonOnce<T>(system: string, user: string, timeoutMs = 20_000): Promise<T | null> {
  if (!isAiConfigured()) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await chat(system, user, { signal: controller.signal, feature: "draft" });
    return result.success ? looseJson<T>(result.data) : null;
  } finally {
    clearTimeout(timer);
  }
}

/** 容忍 ```json 围栏与前后废话：截第一个 { 到最后一个 } 再 parse */
export function looseJson<T>(s: string): T | null {
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)) as T; } catch { return null; }
}
