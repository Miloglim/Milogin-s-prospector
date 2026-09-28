import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ═══════════════════════════════════════════════════════════════════
// 模型端点 Profile + 生效端点解析 单测
// 关键契约：密钥只进 .env（测试写临时文件，绝不碰项目 .env）；
// 激活=写指针不复制密钥；解析优先级 指针 > AGENT_API_KEY > 未配置。
// ═══════════════════════════════════════════════════════════════════

vi.mock("../../src/main/logger", () => ({
  Log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prov-test-"));
const ENV_FILE = path.join(tmp, ".env");
const STORE_FILE = path.join(tmp, "providers.json");

process.env.QW_ENV_PATH = ENV_FILE;
process.env.AI_PROVIDERS_PATH = STORE_FILE;

const KEYS = ["AGENT_API_BASE_URL", "AGENT_MODEL", "AGENT_WIRE_API", "AGENT_KEY_ENV", "AGENT_API_KEY", "DEEPSEEK_API_KEY"];
for (const k of KEYS) delete process.env[k];

const { readActiveEndpoint, endpointFamily, thinkingExtras, thinkingExtrasOn, readLightEndpoint, isOpenAiLuna } = await import("../../src/main/services/endpoint.service");
const NetProxy = await import("../../src/main/net-proxy");
const { parseProxyServer } = NetProxy;
const { upsertEnv, readEnvFile } = await import("../../src/main/env-store");
const Prov = await import("../../src/main/services/provider.service");
const Ai = await import("../../src/main/services/ai.service");
const Once = await import("../../src/main/services/agent/oneshot");
const Harness = await import("../../src/main/services/agent/harness");

beforeAll(() => {
  fs.writeFileSync(ENV_FILE, "", "utf-8");
});

afterEach(() => {
  for (const k of KEYS) delete process.env[k];
  try { fs.rmSync(STORE_FILE, { force: true }); } catch { /* 单测环境 */ }
  fs.writeFileSync(ENV_FILE, "", "utf-8");
});

describe("生效端点解析（endpoint.service）", () => {
  it("指针密钥优先于 legacy AGENT_API_KEY，来源标 profile", () => {
    process.env.AGENT_API_BASE_URL = "https://a.example/v1";
    process.env.AGENT_API_KEY = "sk-legacy";
    process.env.AGENT_KEY_ENV = "PROVIDER_KEY_B";
    process.env.PROVIDER_KEY_B = "sk-new";
    const e = readActiveEndpoint();
    expect(e.apiKey).toBe("sk-new");
    expect(e.source).toBe("profile");
    delete process.env.PROVIDER_KEY_B;
    delete process.env.AGENT_KEY_ENV;
    expect(readActiveEndpoint().source).toBe("legacy");
  });

  it("base 或 key 缺失 → source none / isLive false", () => {
    process.env.AGENT_API_BASE_URL = "https://a.example/v1";
    expect(readActiveEndpoint().source).toBe("none");
  });
});

describe("env-store", () => {
  it("写入后可被 readEnvFile 读回；空值即删除该行", () => {
    upsertEnv("DEEPSEEK_API_KEY", "sk-abc");
    expect(readEnvFile().DEEPSEEK_API_KEY).toBe("sk-abc");
    expect(process.env.DEEPSEEK_API_KEY).toBe("sk-abc");
    upsertEnv("DEEPSEEK_API_KEY", "");
    expect(readEnvFile().DEEPSEEK_API_KEY).toBeUndefined();
    expect(process.env.DEEPSEEK_API_KEY).toBeUndefined();
  });
});

describe("provider.service 端点管理", () => {
  it("Base URL 必须带协议，模型名可先空（未填测试会给明确提示）", () => {
    expect(Prov.upsertProfile({ name: "坏", baseUrl: "api.example.com/v1", model: "m" }).success).toBe(false);
    const ok = Prov.upsertProfile({ name: "A", baseUrl: "https://a.example/v1", model: "model-a" });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.keyEnv).toMatch(/^PROVIDER_KEY_/);
  });

  it("密钥写在 profile 自己的 env 变量里，列表与状态永不回传密钥值", () => {
    const p = Prov.upsertProfile({ name: "B", baseUrl: "https://b.example/v1", model: "model-b" });
    if (!p.success) throw new Error("upsert 失败");
    expect(Prov.setProfileKey(p.data.id, "sk-secret-1").success).toBe(true);
    expect(readEnvFile()[p.data.keyEnv]).toBe("sk-secret-1");

    const list = Prov.listProfiles();
    expect(list.success && list.data[0]!.hasKey).toBe(true);
    expect(JSON.stringify(list)).not.toContain("sk-secret-1");
    const status = Prov.getEndpointStatus();
    expect(JSON.stringify(status)).not.toContain("sk-secret-1");
  });

  it("激活 = 写指针与生效参数，不复制密钥；再切走也不会留下旧密钥副本", () => {
    const a = Prov.upsertProfile({ name: "A", baseUrl: "https://a.example/v1", model: "model-a" });
    const b = Prov.upsertProfile({ name: "B", baseUrl: "https://b.example/v1", model: "model-b" });
    if (!a.success || !b.success) throw new Error("upsert 失败");
    Prov.setProfileKey(a.data.id, "sk-A");
    Prov.setProfileKey(b.data.id, "sk-B");

    const act = Prov.activateProfile(a.data.id);
    expect(act.success).toBe(true);
    expect(process.env.AGENT_API_BASE_URL).toBe("https://a.example/v1");
    expect(process.env.AGENT_MODEL).toBe("model-a");
    expect(process.env.AGENT_KEY_ENV).toBe(a.data.keyEnv);
    expect(readActiveEndpoint().apiKey).toBe("sk-A");
    // 关键：没有把密钥抄成第二份
    expect(process.env.AGENT_API_KEY).toBeUndefined();

    expect(Prov.activateProfile(b.data.id).success).toBe(true);
    expect(readActiveEndpoint().apiKey).toBe("sk-B");
    expect(readActiveEndpoint().model).toBe("model-b");
    expect(process.env.AGENT_API_KEY).toBeUndefined();
  });

  it("磁盘旧档案没有 wireApi 时按 Chat Completions 读取", () => {
    fs.writeFileSync(STORE_FILE, JSON.stringify({ activeId: null, profiles: [
      { id: "legacy", name: "旧档", baseUrl: "https://old.example/v1", model: "old", keyEnv: "PROVIDER_KEY_LEGACY" },
    ] }));
    const result = Prov.listProfiles();
    expect(result.success && result.data[0]?.wireApi).toBe("chat_completions");
  });

  it("旧档案默认 Chat Completions；Responses 档激活和编辑后立即生效", () => {
    const old = Prov.upsertProfile({ name: "旧档", baseUrl: "https://old.example/v1", model: "old" });
    if (!old.success) throw new Error("upsert 失败");
    expect(old.data.wireApi).toBe("chat_completions");
    const modern = Prov.upsertProfile({ name: "新档", baseUrl: "https://gateway.example", model: "gpt-5.6-luna", wireApi: "responses" });
    if (!modern.success) throw new Error("upsert 失败");
    Prov.setProfileKey(modern.data.id, "test-only-key");
    expect(Prov.activateProfile(modern.data.id).success).toBe(true);
    expect(readActiveEndpoint().wireApi).toBe("responses");
    expect(process.env.AGENT_WIRE_API).toBe("responses");
    Prov.upsertProfile({ id: modern.data.id, name: "新档", baseUrl: "https://gateway.example/v1", model: "gpt-5.6-luna", wireApi: "responses" });
    expect(readActiveEndpoint().baseUrl).toBe("https://gateway.example/v1");
    Prov.setProfileKey(old.data.id, "test-only-key");
    expect(Prov.activateProfile(old.data.id).success).toBe(true);
    expect(readActiveEndpoint().wireApi).toBe("chat_completions");
  });

  it("没配密钥的端点不能激活（而不是悄悄切过去变成 401）", () => {
    const p = Prov.upsertProfile({ name: "空", baseUrl: "https://c.example/v1", model: "m" });
    if (!p.success) throw new Error("upsert 失败");
    const r = Prov.activateProfile(p.data.id);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain("密钥");
  });

  it("删除端点连带清掉它在 .env 里的密钥，避免孤儿密钥", () => {
    const p = Prov.upsertProfile({ name: "D", baseUrl: "https://d.example/v1", model: "m" });
    if (!p.success) throw new Error("upsert 失败");
    Prov.setProfileKey(p.data.id, "sk-D");
    expect(Prov.deleteProfile(p.data.id).success).toBe(true);
    expect(readEnvFile()[p.data.keyEnv]).toBeUndefined();
    const left = Prov.listProfiles();
    expect(left.success && left.data).toHaveLength(0);
  });

  it("classifyHttp 把 401/404/429/400(模型名) 归成人话", () => {
    expect(Prov.classifyHttp(401, "").kind).toBe("auth");
    expect(Prov.classifyHttp(404, "").kind).toBe("model");
    expect(Prov.classifyHttp(429, "").kind).toBe("rate");
    const bad = Prov.classifyHttp(400, '{"error":"model name cannot be empty"}');
    expect(bad.kind).toBe("model");
    expect(Prov.classifyHttp(500, "boom").kind).toBe("server");
  });

  it("Luna 连通性测试使用官方推理参数，不向端点发送 temperature/max_tokens", async () => {
    const p = Prov.upsertProfile({ name: "Luna", baseUrl: "https://api.openai.com/v1", model: "gpt-5.6-luna" });
    if (!p.success) throw new Error("upsert 失败");
    Prov.setProfileKey(p.data.id, "test-only-key");
    const request = vi.spyOn(NetProxy, "netFetch").mockResolvedValue(new Response(
      JSON.stringify({ choices: [{ message: { content: "pong" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    try {
      const result = await Prov.testProfile(p.data.id);
      expect(result.success && result.data.ok).toBe(true);
      expect(request).toHaveBeenCalledOnce();
      const [url, init] = request.mock.calls[0]!;
      expect(url).toBe("https://api.openai.com/v1/chat/completions");
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model: "gpt-5.6-luna", max_completion_tokens: 128, reasoning_effort: "none" });
      expect(body).not.toHaveProperty("temperature");
      expect(body).not.toHaveProperty("max_tokens");
      expect(body).not.toHaveProperty("chat_template_kwargs");
    } finally { request.mockRestore(); }
  });

  it("Responses 连通性测试发送 input 并读取 output_text", async () => {
    const p = Prov.upsertProfile({ name: "Responses", baseUrl: "https://gateway.example", model: "gpt-5.6-luna", wireApi: "responses" });
    if (!p.success) throw new Error("upsert 失败");
    Prov.setProfileKey(p.data.id, "test-only-key");
    const request = vi.spyOn(NetProxy, "netFetch").mockResolvedValue(new Response(
      JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "pong" }] }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    try {
      const result = await Prov.testProfile(p.data.id);
      expect(result.success && result.data).toMatchObject({ ok: true, preview: "pong" });
      const [url, init] = request.mock.calls[0]!;
      expect(url).toBe("https://gateway.example/responses");
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model: "gpt-5.6-luna", input: "Reply pong", store: false });
      expect(body).not.toHaveProperty("messages");
    } finally { request.mockRestore(); }
  });

  it("网页误响应不能通过连接测试，要提示 API 路径或接口类型", async () => {
    const p = Prov.upsertProfile({ name: "网页根地址", baseUrl: "https://gateway.example", model: "gpt-5.6-luna" });
    if (!p.success) throw new Error("upsert 失败");
    Prov.setProfileKey(p.data.id, "test-only-key");
    const request = vi.spyOn(NetProxy, "netFetch").mockResolvedValue(new Response("<!doctype html><html></html>", { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }));
    try {
      const result = await Prov.testProfile(p.data.id);
      expect(result.success && result.data).toMatchObject({ ok: false, kind: "badrequest" });
      if (result.success) expect(result.data.error).toContain("接口类型");
    } finally { request.mockRestore(); }
  });

  it("测试未填模型名的端点：直接给人话提示，不发请求", async () => {
    const p = Prov.upsertProfile({ name: "无模型", baseUrl: "https://e.example/v1", model: "" });
    if (!p.success) throw new Error("upsert 失败");
    Prov.setProfileKey(p.data.id, "sk-E");
    const r = await Prov.testProfile(p.data.id);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.ok).toBe(false);
      expect(r.data.kind).toBe("model");
    }
  });
});

describe("Luna 实际调用参数", () => {
  const configure = () => {
    process.env.AGENT_API_BASE_URL = "https://api.openai.com/v1";
    process.env.AGENT_MODEL = "gpt-5.6-luna";
    process.env.AGENT_API_KEY = "test-only-key";
  };

  it("轻任务使用指定思考级别，默认不发送 temperature", async () => {
    configure();
    const request = vi.spyOn(NetProxy, "netFetch").mockImplementation(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 },
    ));
    try {
      expect((await Ai.chat("system", "user")).success).toBe(true);
      const body = JSON.parse(String(request.mock.calls[0]![1]?.body));
      expect(body).toMatchObject({ model: "gpt-5.6-luna", reasoning_effort: "none" });
      expect(body).not.toHaveProperty("temperature");
      expect((await Ai.chat("system", "user", { thinking: true })).success).toBe(true);
      expect(JSON.parse(String(request.mock.calls[1]![1]?.body)).reasoning_effort).toBe("low");
    } finally { request.mockRestore(); }
  });

  it("轻任务收到网页时明确提示配置错误", async () => {
    configure();
    const request = vi.spyOn(NetProxy, "netFetch").mockResolvedValue(new Response("<!doctype html>", { status: 200, headers: { "Content-Type": "text/html" } }));
    try {
      const result = await Ai.chat("system", "user");
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain("不是模型 API");
    } finally { request.mockRestore(); }
  });

  it("Agent 收到网页时立即失败，不消耗完整回合步数", async () => {
    const request = vi.spyOn(NetProxy, "netFetch").mockImplementation(async () => new Response("<!doctype html>", { status: 200, headers: { "Content-Type": "text/html" } }));
    try {
      await expect(Harness.runHarnessTurn(
        { name: "test", maxTurns: 2, toolNames: [], buildInstructions: () => "Reply to the user" },
        { baseUrl: "https://gateway.example", apiKey: "test-only-key", model: "gpt-5.6-luna", history: [{ role: "user", content: "test" }], conversationId: "test", push: () => {}, signal: new AbortController().signal },
      )).rejects.toThrow("不是模型 API");
      expect(request.mock.calls.length).toBeLessThan(16);
    } finally { request.mockRestore(); }
  });

  it("Responses 轻任务与一次性解析走各自接口，不读取 choices", async () => {
    process.env.AGENT_API_BASE_URL = "https://gateway.example";
    process.env.AGENT_MODEL = "gpt-5.6-luna";
    process.env.AGENT_API_KEY = "test-only-key";
    process.env.AGENT_WIRE_API = "responses";
    const request = vi.spyOn(NetProxy, "netFetch").mockImplementation(async () => new Response(
      JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "{\"ok\":true}" }] }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    try {
      expect((await Ai.chat("system", "user")).success).toBe(true);
      expect(request.mock.calls[0]![0]).toBe("https://gateway.example/responses");
      expect(JSON.parse(String(request.mock.calls[0]![1]?.body))).toMatchObject({ instructions: "system", input: "user", store: false });
      expect(await Once.askJsonOnce<{ ok: boolean }>("Reply in JSON", "user")).toEqual({ ok: true });
      expect(String(request.mock.calls[1]![0])).toBe("https://gateway.example/responses");
      expect(JSON.parse(String(request.mock.calls[1]![1]?.body))).toMatchObject({ max_output_tokens: 400, store: false });
    } finally { request.mockRestore(); }
  });

  it("Responses Agent 流式正文经 SDK 正常交付", async () => {
    const response = { id: "resp_test", object: "response", created_at: 0, model: "gpt-5.6-luna", status: "completed",
      output: [{ type: "message", id: "msg_test", status: "completed", role: "assistant",
        content: [{ type: "output_text", text: "pong", annotations: [] }] }],
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } };
    const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    const sse = event("response.created", { type: "response.created", response: { ...response, status: "in_progress", output: [] } })
      + event("response.output_text.delta", { type: "response.output_text.delta", delta: "pong", item_id: "msg_test", output_index: 0, content_index: 0 })
      + event("response.completed", { type: "response.completed", response }) + "data: [DONE]\n\n";
    const request = vi.spyOn(NetProxy, "netFetch").mockImplementation(async () => new Response(sse,
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    ));
    const chunks: string[] = [];
    try {
      const result = await Harness.runHarnessTurn(
        { name: "test", maxTurns: 2, toolNames: [], buildInstructions: () => "Reply to the user" },
        { baseUrl: "https://gateway.example", apiKey: "test-only-key", model: "gpt-5.6-luna", wireApi: "responses",
          history: [{ role: "user", content: "test" }], conversationId: "test",
          push: (channel, data) => { if (channel === "agent:chunk") chunks.push(String((data as { delta?: string }).delta)); },
          signal: new AbortController().signal },
      );
      expect(result.kind).toBe("done");
      expect(result.text).toBe("pong");
      expect(chunks.join("")).toBe("pong");
      expect(request.mock.calls[0]![0]).toBe("https://gateway.example/responses");
      const body = JSON.parse(String(request.mock.calls[0]![1]?.body));
      expect(body).toMatchObject({ model: "gpt-5.6-luna", stream: true, store: false, reasoning: { effort: "none" } });
      expect(body).not.toHaveProperty("messages");
    } finally { request.mockRestore(); }
  });

  it("一次性 JSON 解析使用 max_completion_tokens", async () => {
    configure();
    const request = vi.spyOn(NetProxy, "netFetch").mockImplementation(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: "{\"ok\":true}" } }] }), { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    try {
      expect(await Once.askJsonOnce<{ ok: boolean }>("Reply in JSON", "user")).toEqual({ ok: true });
      const body = JSON.parse(String(request.mock.calls[0]![1]?.body));
      expect(body).toMatchObject({ model: "gpt-5.6-luna", reasoning_effort: "none", max_completion_tokens: 400 });
      expect(body).not.toHaveProperty("max_tokens");
      expect(body).not.toHaveProperty("temperature");
    } finally { request.mockRestore(); }
  });
});

describe("出网代理自动检测", () => {
  it("解析注册表 ProxyServer 的两种写法", () => {
    expect(parseProxyServer("127.0.0.1:7890")).toBe("http://127.0.0.1:7890");
    expect(parseProxyServer("http=127.0.0.1:7890;https=127.0.0.1:7890;ftp=127.0.0.1:7890"))
      .toBe("http://127.0.0.1:7890");
    expect(parseProxyServer("")).toBe("");
    // 没有端口 / 只有 socks 之类不可直接当 http 代理用的写法 → 不采用（宁可直连）
    expect(parseProxyServer("proxy.example.com")).toBe("");
    expect(parseProxyServer("socks=127.0.0.1:1080")).toBe("");
  });
});

describe("轻任务端点（大小模型路由）", () => {
  it("未配置 LIGHT_* → 回落主端点（source=main，行为与今天一致）", () => {
    const e = readLightEndpoint({ baseUrl: "https://main/v1", apiKey: "sk-main", model: "big", source: "profile" });
    expect(e.source).toBe("main");
    expect(e.model).toBe("big");
  });

  it("主端点 Responses 回落到轻任务；独立轻任务默认 Chat Completions", () => {
    const main = { baseUrl: "https://main.example", apiKey: "test-only-key", model: "big", wireApi: "responses" as const, source: "profile" as const };
    expect(readLightEndpoint(main).wireApi).toBe("responses");
    process.env.LIGHT_API_BASE_URL = "https://light.example/v1";
    process.env.LIGHT_MODEL = "small";
    process.env.LIGHT_API_KEY = "test-only-key";
    expect(readLightEndpoint(main).wireApi).toBe("chat_completions");
    delete process.env.LIGHT_API_BASE_URL; delete process.env.LIGHT_MODEL; delete process.env.LIGHT_API_KEY;
  });

  it("配置齐备 → 走轻任务档；指针密钥优先于 legacy", () => {
    process.env.LIGHT_API_BASE_URL = "https://light.example/v1";
    process.env.LIGHT_MODEL = "small-cheap";
    process.env.LIGHT_KEY_ENV = "LIGHT_KEY_A";
    process.env.LIGHT_KEY_A = "sk-light";
    const e = readLightEndpoint();
    expect(e.source).toBe("light");
    expect(e.apiKey).toBe("sk-light");
    expect(e.model).toBe("small-cheap");
    delete process.env.LIGHT_API_BASE_URL; delete process.env.LIGHT_MODEL;
    delete process.env.LIGHT_KEY_ENV; delete process.env.LIGHT_KEY_A;
  });

  it("缺任一项（base/密钥/模型）→ 视为未配置，回落主端点", () => {
    process.env.LIGHT_API_BASE_URL = "https://light.example/v1";
    process.env.LIGHT_MODEL = "small-cheap";
    // 没有密钥
    const e = readLightEndpoint({ baseUrl: "https://main/v1", apiKey: "sk-main", model: "big", source: "profile" });
    expect(e.source).toBe("main");
    delete process.env.LIGHT_API_BASE_URL; delete process.env.LIGHT_MODEL;
  });
});

describe("端点族识别与关思考参数方言", () => {
  it("仅官方 OpenAI 主机的 Luna 应用专属参数，兼容网关不受影响", () => {
    expect(isOpenAiLuna("https://api.openai.com/v1", "gpt-5.6-luna")).toBe(true);
    expect(isOpenAiLuna("https://api.openai.com.evil.test/v1", "gpt-5.6-luna")).toBe(false);
    expect(isOpenAiLuna("https://proxy.example/v1", "gpt-5.6-luna")).toBe(false);
  });

  it("按域名识别 google / ollama / openai / compat", () => {
    expect(endpointFamily("https://generativelanguage.googleapis.com/v1beta/openai")).toBe("google");
    expect(endpointFamily("http://localhost:11434/v1")).toBe("ollama");
    expect(endpointFamily("https://api.openai.com/v1")).toBe("openai");
    expect(endpointFamily("https://api.deepseek.com/v1")).toBe("strict");
    expect(endpointFamily("https://apihub.agnes-ai.com/v1")).toBe("compat");
  });

  it("google / openai 族不注入扩展字段（顶层 google/thinking_budget 会被兼容层判 400）", () => {
    // 这条曾经把 24 张卡全打挂：给 Gemini 塞了 google.thinking_config → Invalid JSON payload
    expect(thinkingExtras("google")).toEqual({});
    expect(thinkingExtras("openai")).toEqual({});
    expect(thinkingExtras("openai").chat_template_kwargs).toBeUndefined();
  });

  it("严格白名单网关（DeepSeek）恒注入 thinking:disabled（根治 RC 回传 400）", () => {
    // V4 默认思考 → API 要求历史 assistant 回传 reasoning_content，而应用从不回传 → 多轮间歇 400。
    // 恒关思考后模型不吐 RC，该规则无从触发。实测 deepseek-chat/v4-flash/v4-pro 均认此顶层键。
    expect(thinkingExtras("strict")).toEqual({ thinking: { type: "disabled" } });
  });

  it("Ollama 与 vLLM/agnes 各自用自己认的键关思考", () => {
    expect(thinkingExtras("ollama")).toEqual({ chat_template_kwargs: { thinking: false } });
    expect(thinkingExtras("compat")).toEqual({ chat_template_kwargs: { enable_thinking: false, thinking: false } });
  });

  it("单发合成调用开思考方言（起草/背调）：单发无 assistant 历史，RC 回传约束不存在", () => {
    expect(thinkingExtrasOn("strict")).toEqual({ thinking: { type: "enabled" } });
    expect(thinkingExtrasOn("compat")).toEqual({ chat_template_kwargs: { enable_thinking: true, thinking: true } });
    expect(thinkingExtrasOn("ollama")).toEqual({ chat_template_kwargs: { thinking: true } });
    expect(thinkingExtrasOn("openai")).toEqual({ reasoning_effort: "low" });
    expect(thinkingExtrasOn("google")).toEqual({});   // 兼容层无可用思考控制字段，交给端点自己
  });
});
