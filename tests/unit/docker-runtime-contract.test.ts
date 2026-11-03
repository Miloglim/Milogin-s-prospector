import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("QA4 Docker runtime contract", () => {
  it("provides lifecycle curl and a writable standard log directory", () => {
    const source = readFileSync(resolve(process.cwd(), "Dockerfile"), "utf8");

    expect(source).toContain("apt-get install -y --no-install-recommends curl");
    expect(source).toContain("/opt/web/ws-${APP_PORT}/logs");
    expect(source).toContain("chown -R node:node /opt/web/ws-${APP_PORT} /var/lib/prospector-center");
    expect(source.indexOf("USER node")).toBeGreaterThan(source.indexOf("chown -R node:node"));
  });
});
