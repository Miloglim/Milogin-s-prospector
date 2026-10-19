import { describe, expect, it } from "vitest";
import { pbkdf2Sync } from "node:crypto";
import { PasswordAdapter } from "../../server/adapters/password";

describe("legacy Navigator password compatibility", () => {
  it("verifies the existing pbkdf2_sha256 format without exposing the digest", async () => {
    const password = "Legacy-Password-123";
    const iterations = 310000;
    const salt = "00112233445566778899aabbccddeeff";
    const digest = pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("hex");
    const legacy = `pbkdf2_sha256$${iterations}$${salt}$${digest}`;
    const adapter = new PasswordAdapter(1);
    await adapter.initialize();
    await expect(adapter.verify(password, legacy)).resolves.toBe(true);
    await expect(adapter.verify("wrong", legacy)).resolves.toBe(false);
  });

  it("continues to verify the central scrypt format", async () => {
    const adapter = new PasswordAdapter(1);
    await adapter.initialize();
    const hash = await adapter.hash("Central-Password-123");
    await expect(adapter.verify("Central-Password-123", hash)).resolves.toBe(true);
  });
});
