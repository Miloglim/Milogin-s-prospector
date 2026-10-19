import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { readTestDatabaseConfig } from "../../server/adapters/postgres/config";
import { PostgresAuthRepository } from "../../server/adapters/postgres/auth-repository";
import { ACCOUNT_PROFILE_SCHEMA_VERSION } from "../../server/adapters/postgres/account-profile-schema";
import { ACCOUNT_GROWTH_SCHEMA_VERSION } from "../../server/adapters/postgres/account-growth-schema";
import { PASSWORD_COMPAT_SCHEMA_VERSION } from "../../server/adapters/postgres/password-compat-schema";
import { LEGACY_ACCOUNT_MAPPING_SCHEMA_VERSION } from "../../server/adapters/postgres/legacy-account-mapping-schema";

describe.runIf(process.env.PROSPECTOR_PG_INTEGRATION === "1")("central account profile and growth schema", () => {
  let pool: Pool;
  const log = { write: () => {} };

  beforeAll(async () => {
    pool = new Pool(readTestDatabaseConfig());
    const repository = new PostgresAuthRepository(pool, log);
    expect((await repository.migrate()).ok).toBe(true);
    expect((await repository.migrate()).ok).toBe(true);
  });

  afterAll(async () => { await pool?.end(); });

  it("records both migrations once and stores shared profile plus growth projection", async () => {
    const versions = (await pool.query(
      "SELECT version FROM crm_schema_migrations WHERE version = ANY($1::text[]) ORDER BY version",
      [[ACCOUNT_PROFILE_SCHEMA_VERSION, ACCOUNT_GROWTH_SCHEMA_VERSION, PASSWORD_COMPAT_SCHEMA_VERSION, LEGACY_ACCOUNT_MAPPING_SCHEMA_VERSION]],
    )).rows.map(row => row.version);
    expect(versions).toEqual([ACCOUNT_GROWTH_SCHEMA_VERSION, ACCOUNT_PROFILE_SCHEMA_VERSION, PASSWORD_COMPAT_SCHEMA_VERSION, LEGACY_ACCOUNT_MAPPING_SCHEMA_VERSION].sort());

    const userId = randomUUID();
    const eventId = randomUUID();
    try {
      await pool.query("INSERT INTO identity.users(user_id,display_name) VALUES($1,$2)", [userId, "Schema fixture"]);
      await pool.query("INSERT INTO identity.legacy_account_mappings(source_product,legacy_user_id,legacy_login_alias,status,center_user_id,requires_password_reset) VALUES('navigator',$1,$2,'matched',$3,true)", [`legacy-${userId}`, `legacy-${userId}`, userId]);
      await pool.query("INSERT INTO identity.credentials(user_id,password_hash,hash_scheme) VALUES($1,$2,$3)", [userId, "pbkdf2_sha256$310000$00112233445566778899aabbccddeeff$" + "0".repeat(64), "pbkdf2_sha256"]);
      await pool.query("INSERT INTO identity.user_profiles(user_id,avatar_id,bio) VALUES($1,$2,$3)", [userId, "avatar-1", "shared profile"]);
      await pool.query("INSERT INTO identity.login_aliases(alias,user_id) VALUES($1,$2)", [`schema-${userId}`, userId]);
      await pool.query(`INSERT INTO identity.account_experience_events
        (event_id,user_id,source_product,event_type,subject_key,points,rule_version,occurred_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [eventId, userId, "navigator", "daily_effective_search", `day:${userId}`, 18, 2, new Date()]);
      await pool.query("INSERT INTO identity.account_growth_projection(user_id,total_xp,cycle,level,today_xp,today_key) VALUES($1,$2,$3,$4,$5,CURRENT_DATE)", [userId, 18, 1, 2, 18]);
      expect((await pool.query("SELECT avatar_id,bio FROM identity.user_profiles WHERE user_id=$1", [userId])).rows[0]).toEqual({ avatar_id: "avatar-1", bio: "shared profile" });
      expect((await pool.query("SELECT status,requires_password_reset FROM identity.legacy_account_mappings WHERE center_user_id=$1", [userId])).rows[0]).toEqual({ status: "matched", requires_password_reset: true });
      await expect(pool.query(`INSERT INTO identity.account_experience_events
        (event_id,user_id,source_product,event_type,subject_key,points,rule_version,occurred_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [randomUUID(), userId, "navigator", "daily_effective_search", `day:${userId}`, 18, 2, new Date()])).rejects.toMatchObject({ code: "23505" });
    } finally {
      await pool.query("DELETE FROM identity.legacy_account_mappings WHERE center_user_id=$1", [userId]);
      await pool.query("DELETE FROM identity.credentials WHERE user_id=$1", [userId]);
      await pool.query("DELETE FROM identity.users WHERE user_id=$1", [userId]);
    }
  });
});
