import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("route keep-alive policy", () => {
  it("keeps only the active send center alive", () => {
    const source = readFileSync(resolve(process.cwd(), "src/renderer/router.tsx"), "utf8");

    expect(source).toContain('"/campaigns": SendCenter');
    expect(source).not.toContain('"/customers": LegacyCustomersPage');
  });
});
