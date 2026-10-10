import { expect, it } from "vitest";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

it("真实 Electron SQLite：迁移幂等、搜索增改删/全文/中文、阶段与签名链路", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "prospector-backend-test-"));
  try {
    const runner = path.join(sandbox, "dist", "main", "runtime.cjs");
    await build({ entryPoints: ["tests/fixtures/backend-runtime.ts"], outfile: runner, bundle: true, platform: "node", format: "cjs", packages: "external" });
    const output = execFileSync(require("electron") as string, [runner], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_PATH: path.resolve("node_modules"), BACKEND_ROLLBACK_SQL: path.resolve("docs/backend-search-rollback.sql") },
      cwd: sandbox, encoding: "utf8", timeout: 30_000, windowsHide: true,
    });
    expect(output).toContain("BACKEND_RUNTIME_OK");
  } finally {
    const target = path.resolve(sandbox);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith("prospector-backend-test-")) throw new Error("Unsafe sandbox cleanup path");
    fs.rmSync(target, { recursive: true, force: true });
  }
}, 45_000);
