import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pbkdf2Sync, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { readTestDatabaseConfig } from "../../server/adapters/postgres/config";
import { PostgresAuthRepository } from "../../server/adapters/postgres/auth-repository";
import { PasswordAdapter } from "../../server/adapters/password";

describe.runIf(process.env.PROSPECTOR_PG_INTEGRATION === "1")("legacy account migration rehearsal", () => {
  let pool: Pool;
  let passwords: PasswordAdapter;
  const log = { write: () => {} };

  beforeAll(async () => {
    pool = new Pool(readTestDatabaseConfig());
    expect((await new PostgresAuthRepository(pool, log).migrate()).ok).toBe(true);
    passwords = new PasswordAdapter(1);
    await passwords.initialize();
  });

  afterAll(async () => { await pool?.end(); });

  it("rehearses one old account from PBKDF2 to central scrypt", async () => {
    const centerUserId = randomUUID();
    const legacyUserId = `rehearsal-${centerUserId}`;
    const alias = `rehearsal-${centerUserId}`;
    const password = "Rehearsal-Password-123";
    const salt = "00112233445566778899aabbccddeeff";
    const digest = pbkdf2Sync(password, salt, 310000, 32, "sha256").toString("hex");
    const legacyHash = `pbkdf2_sha256$310000$${salt}$${digest}`;
    try {
      await pool.query("INSERT INTO identity.users(user_id,display_name) VALUES($1,$2)", [centerUserId, "Rehearsal User"]);
      await pool.query("INSERT INTO identity.credentials(user_id,password_hash,hash_scheme) VALUES($1,$2,'pbkdf2_sha256')", [centerUserId, legacyHash]);
      await pool.query(`INSERT INTO identity.legacy_account_mappings
        (source_product,legacy_user_id,legacy_login_alias,center_user_id,status,requires_password_reset)
        VALUES('navigator',$1,$2,$3,'matched',true)`, [legacyUserId, alias, centerUserId]);

      expect(await passwords.verify(password, legacyHash)).toBe(true);
      const upgradedHash = await passwords.hash(password);
      await pool.query("UPDATE identity.credentials SET password_hash=$2,hash_scheme='scrypt-v1',changed_at=now() WHERE user_id=$1", [centerUserId, upgradedHash]);
      await pool.query("UPDATE identity.legacy_account_mappings SET status='migrated',requires_password_reset=false,updated_at=now() WHERE center_user_id=$1", [centerUserId]);

      const credential = (await pool.query("SELECT password_hash,hash_scheme FROM identity.credentials WHERE user_id=$1", [centerUserId])).rows[0];
      expect(credential.hash_scheme).toBe("scrypt-v1");
      expect(credential.password_hash).toBe(upgradedHash);
      expect(credential.password_hash).not.toBe(legacyHash);
      expect(await passwords.verify(password, credential.password_hash)).toBe(true);
      expect((await pool.query("SELECT status,requires_password_reset FROM identity.legacy_account_mappings WHERE center_user_id=$1", [centerUserId])).rows[0]).toEqual({ status: "migrated", requires_password_reset: false });
    } finally {
      await pool.query("DELETE FROM identity.legacy_account_mappings WHERE center_user_id=$1", [centerUserId]);
      await pool.query("DELETE FROM identity.credentials WHERE user_id=$1", [centerUserId]);
      await pool.query("DELETE FROM identity.users WHERE user_id=$1", [centerUserId]);
    }
  });
});
