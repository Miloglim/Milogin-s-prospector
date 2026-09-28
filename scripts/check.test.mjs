import assert from "node:assert/strict";
import test from "node:test";
import { extractSpecifiers, hasIpcHandle, inspectFile, validateBaseline } from "./check.mjs";

test("解析 import、dynamic import、export from 和 require，忽略注释", () => {
  const source = `
    // require("ignored")
    import { app } from "electron";
    export { x } from "../db/schema";
    const fs = require("node:fs");
    await import("../services/a");
  `;
  assert.deepEqual(extractSpecifiers(source).sort(), ["../db/schema", "../services/a", "electron", "node:fs"]);
});

test("transport 的 DB 依赖必须失败，登记的精确例外可暂时放行", () => {
  const source = `import { getDb } from "../db";`;
  const empty = inspectFile("src/main/transport/a.ipc.ts", source, new Map());
  assert.equal(empty[0]?.rule, "transport-db");

  const entries = new Map([["src/main/transport/a.ipc.ts|transport-db|../db", {}]]);
  assert.deepEqual(inspectFile("src/main/transport/a.ipc.ts", source, entries), []);
});

test("service 的 Electron require 和非 transport IPC handler 都必须失败", () => {
  const service = inspectFile("src/main/services/a.service.ts", `const e = require("electron");`, new Map());
  assert.equal(service[0]?.rule, "service-electron");

  const handler = inspectFile("src/main/index.ts", `ipcMain.handle("x", () => {});`, new Map());
  assert.equal(handler[0]?.rule, "ipc-handler-location");
  assert.equal(hasIpcHandle(`// ipcMain.handle("ignored")\nipcMain.handle("x", () => {});`), true);
});

test("过期或不完整的基线例外必须失败", () => {
  const result = validateBaseline({
    exceptions: [
      { file: "a", rule: "r", specifier: "s", ticket: "ARCH-1", reason: "x", expires: "2020-01-01" },
      { file: "b", rule: "r", specifier: "s", expires: "2099-01-01" },
    ],
  }, new Date("2026-09-24T00:00:00Z"));
  assert.equal(result.errors.length, 2);
});

test("已放行的例外会被标记为仍在使用", () => {
  const entries = new Map([["src/main/transport/a.ipc.ts|transport-db|../db", {}]]);
  const used = new Set();
  inspectFile("src/main/transport/a.ipc.ts", `import { getDb } from "../db";`, entries, used);
  assert.deepEqual([...used], ["src/main/transport/a.ipc.ts|transport-db|../db"]);
});
