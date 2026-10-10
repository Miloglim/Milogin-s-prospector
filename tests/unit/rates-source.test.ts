import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 现行台账只在局域网 8795；历史公网 source/url 不能再参与读取。
// 优先级：有效局域网 env > 有效局域网配置 url > 内置局域网地址。

const cfgHolder: { rates?: { source?: string; url?: string } } = {};

vi.mock("../../src/main/db", () => ({
  getDb: () => null, saveDatabase: () => {}, getRawDb: () => null,
}));
vi.mock("../../src/main/logger", () => ({
  Log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));
vi.mock("../../src/main/config", () => ({
  APP_ROOT: ".", DB_PATH: "test.db",
  loadConfig: () => ({ rates: cfgHolder.rates }),
  saveConfig: () => {},
}));

const { remoteBase, LAN_BASE } = await import("../../src/main/services/rate-sync.service");

describe("运价台账地址来源", () => {
  const savedEnv = process.env.RATES_REMOTE_URL;
  beforeEach(() => { delete process.env.RATES_REMOTE_URL; cfgHolder.rates = undefined; });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.RATES_REMOTE_URL;
    else process.env.RATES_REMOTE_URL = savedEnv;
  });

  it("什么都不配 = 现行 8795 局域网接口", () => {
    expect(remoteBase()).toBe(LAN_BASE);
    expect(LAN_BASE).toBe("http://192.168.190.244:8795");
  });

  it("历史公网选项和公网 URL 不再生效", () => {
    cfgHolder.rates = { source: "remote", url: "https://old.example.test" };
    expect(remoteBase()).toBe(LAN_BASE);
    process.env.RATES_REMOTE_URL = "https://old.example.test";
    expect(remoteBase()).toBe(LAN_BASE);
  });

  it("自定义 url 优先于 source，尾斜杠去掉", () => {
    cfgHolder.rates = { source: "lan", url: "http://10.0.0.7:8795/" };
    expect(remoteBase()).toBe("http://10.0.0.7:8795");
  });

  it("环境变量优先级最高（换网络环境/临时调试不改配置）", () => {
    cfgHolder.rates = { source: "lan", url: "http://10.0.0.7:8795" };
    process.env.RATES_REMOTE_URL = "http://127.0.0.1:9/";
    expect(remoteBase()).toBe("http://127.0.0.1:9");
  });

  it("配置读不到（异常/首启）也回落内置局域网，不抛", () => {
    cfgHolder.rates = undefined;
    expect(() => remoteBase()).not.toThrow();
    expect(remoteBase()).toBe(LAN_BASE);
  });
});
