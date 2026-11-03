import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("QA4 Docker runtime contract", () => {
  it("provides lifecycle curl without relying on the base image apt metadata", () => {
    const source = readFileSync(resolve(process.cwd(), "Dockerfile"), "utf8");

    expect(source).toContain("AS curl-tools");
    expect(source).toContain("export_curl_runtime.py /tmp/curl-runtime");
    expect(source).toContain("COPY --from=curl-tools /tmp/curl-runtime/ /");
    expect(source).toContain("curl --version");
    expect(source).not.toContain("apt-get update");
    expect(source).not.toContain("apt-get install");
  });

  it("creates a writable standard log directory", () => {
    const source = readFileSync(resolve(process.cwd(), "Dockerfile"), "utf8");

    expect(source).toContain("/opt/web/ws-${APP_PORT}/logs");
    expect(source).toContain("chown -R node:node /opt/web/ws-${APP_PORT} /var/lib/prospector-center");
    expect(source.indexOf("USER node")).toBeGreaterThan(source.indexOf("chown -R node:node"));
  });
});
