# Unified Account Domain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add the central PostgreSQL account profile and cross-product growth domain without switching Navigator login or touching production data.

**Architecture:** Keep `identity.users` as the shared identity anchor. Store avatar and shared profile fields in `identity.user_profiles`, login aliases in a central table, and experience events/projections in the central identity schema. Product systems submit idempotent facts later; this milestone only creates the contracts, schema, migration, and isolated verification needed for that handoff.

**Tech Stack:** TypeScript, PostgreSQL, `pg`, Vitest, existing checksum-guarded migration repositories.

**Spec:** `docs/navigator-center-identity-mapping-20261018.md`

## Global Constraints

- Preserve the existing `core/` → `services/` → `transport/` separation.
- Add no dependency; use existing `pg`, `crypto`, and Vitest.
- Return `{ ok, data?, error? }` from runtime ports.
- Do not read or copy plaintext passwords, tokens, or private keys.
- Do not connect Navigator to the center or alter production PostgreSQL in this milestone.
- Every schema change is checksum guarded and repeatable.
- Do not modify existing uncommitted work outside files listed in a task.

---

### Task 1: Define central profile and growth contracts

**Files:**
- Create: `server/core/account-profile.ts`
- Create: `server/core/account-growth.ts`
- Test: `tests/unit/account-domain-contracts.test.ts`

**Interfaces:**
- `account-profile.ts` exports `ACCOUNT_PROFILE_LIMITS`, `AccountProfile`, `AccountProfilePatch`, `LoginAlias` and `normalizeLoginAlias(value: string): string`.
- `account-growth.ts` exports `GROWTH_SOURCE_PRODUCTS`, `GrowthSourceProduct`, `GrowthEventDraft`, `GrowthProjection`, and `isGrowthEventDraft(value: unknown): value is GrowthEventDraft`.

- [x] **Step 1: Write failing contract tests**

  Test that aliases are trimmed/lower-cased, empty aliases are rejected, profile patches only allow `avatarId` and `bio`, growth source products accept `navigator` and `crm`, and event drafts reject empty `subjectKey` or non-positive points.

- [ ] **Step 2: Run the focused test and verify it fails**

  Run: `npm.cmd exec vitest run tests/unit/account-domain-contracts.test.ts`
  Expected: FAIL because the new modules do not exist.

- [x] **Step 3: Implement the smallest pure contracts**

  Keep validation pure and dependency-free. Use constants for maximum alias length, avatar ID length, bio length, event type length, and points bounds. Do not add a database call or HTTP route.

- [x] **Step 4: Run the focused test**

  Run: `npm.cmd exec vitest run tests/unit/account-domain-contracts.test.ts`
  Expected: PASS.

### Task 2: Add checksum-guarded identity profile and growth schema

**Files:**
- Create: `server/adapters/postgres/account-profile-schema.ts`
- Create: `server/adapters/postgres/account-growth-schema.ts`
- Modify: `server/adapters/postgres/auth-repository.ts`
- Test: `tests/integration/account-domain-schema.test.ts`

**Interfaces:**
- `account-profile-schema.ts` exports `ACCOUNT_PROFILE_SCHEMA_VERSION`, `ACCOUNT_PROFILE_SCHEMA_LOCK`, and `ACCOUNT_PROFILE_SCHEMA_SQL`.
- `account-growth-schema.ts` exports `ACCOUNT_GROWTH_SCHEMA_VERSION`, `ACCOUNT_GROWTH_SCHEMA_LOCK`, and `ACCOUNT_GROWTH_SCHEMA_SQL`.
- `PostgresAuthRepository.migrate()` applies both migrations after the existing identity/password/session migrations, each using the existing `crm_schema_migrations` checksum protocol.

- [x] **Step 1: Write the isolated PostgreSQL migration test**

  Use the existing `PROSPECTOR_PG_INTEGRATION` guard and `readTestDatabaseConfig()`. Call `migrate()` twice, assert both versions occur exactly once, inspect the columns and constraints, insert a temporary user, profile, alias, event, and projection, then roll the inserted rows back or delete them in `afterEach`. Assert that a duplicate canonical event key is rejected.

- [ ] **Step 2: Run the test to verify the new migration is absent**

  Run: `$env:PROSPECTOR_PG_INTEGRATION='1'; npm.cmd exec vitest run tests/integration/account-domain-schema.test.ts`
  Expected: FAIL because the schema modules and migration wiring do not exist.

- [x] **Step 3: Implement the profile schema**

  Create `identity.user_profiles(user_id uuid PRIMARY KEY REFERENCES identity.users(user_id) ON DELETE CASCADE, avatar_id text NOT NULL DEFAULT 'default', bio text NOT NULL DEFAULT '', updated_at timestamptz NOT NULL DEFAULT now())` with length checks. Create `identity.login_aliases(alias text PRIMARY KEY, user_id uuid NOT NULL REFERENCES identity.users(user_id) ON DELETE CASCADE, created_at timestamptz NOT NULL DEFAULT now())` and a user index. Store aliases centrally as lower-case values; do not name the table `navigator_users`.

- [x] **Step 4: Implement the growth schema**

  Create `identity.account_experience_events(event_id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES identity.users(user_id) ON DELETE CASCADE, source_product text NOT NULL, event_type text NOT NULL, subject_key text NOT NULL, points integer NOT NULL, rule_version integer NOT NULL, occurred_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,source_product,event_type,subject_key), CHECK(points > 0), CHECK(rule_version > 0), CHECK(btrim(source_product) <> ''), CHECK(btrim(event_type) <> ''), CHECK(btrim(subject_key) <> ''))` and `identity.account_growth_projection(user_id uuid PRIMARY KEY REFERENCES identity.users(user_id) ON DELETE CASCADE, total_xp integer NOT NULL DEFAULT 0, cycle integer NOT NULL DEFAULT 1, level integer NOT NULL DEFAULT 1, today_xp integer NOT NULL DEFAULT 0, today_key date, updated_at timestamptz NOT NULL DEFAULT now(), CHECK(total_xp >= 0), CHECK(cycle > 0), CHECK(level > 0), CHECK(today_xp >= 0)`. Add user/time indexes.

- [x] **Step 5: Wire both migrations into `PostgresAuthRepository.migrate()`**

  Follow the existing pattern: acquire each advisory lock, hash the exact SQL string, reject checksum drift, create the SQL once, and insert the version/checksum once. Keep failures in the existing `{ ok, error }` form.

- [x] **Step 6: Run the focused integration test**

  Run: `$env:PROSPECTOR_PG_INTEGRATION='1'; npm.cmd exec vitest run tests/integration/account-domain-schema.test.ts`
  Expected: PASS; the second migration call must be idempotent.

### Task 3: Document the first migration boundary and verify repository checks

**Files:**
- Modify: `docs/database-schema.md`
- Modify: `docs/IPC契约.md` only if a public IPC contract is added (expected: no change in this milestone)
- Modify: `docs/架构基底.md`
- Modify: `docs/版本记录.md`

- [x] **Step 1: Record the new schema boundary**

  Document the four shared tables, their ownership, the rule that `identity.users` remains the identity anchor, and the fact that product services must submit idempotent facts rather than independently recompute shared XP.

- [x] **Step 2: Record the version entry**

  Add a patch/minor entry according to the repository’s current version policy, describing schema preparation only. Do not mark Navigator as connected and do not claim migration completion.

- [x] **Step 3: Run checks**

  Run: `npm.cmd exec vitest run tests/unit/account-domain-contracts.test.ts`; `npm.cmd run typecheck`; `npm.cmd run check`.
  Expected: all focused checks pass and architecture check reports zero new violations.

### Task 4: Stop at the migration gate

- [x] **Step 1: Produce a read-only Navigator mapping report**

  Inspect the real Navigator `operators`, `account_experience_events`, `preferences_json`, and publisher fields. Produce counts and field mappings without copying passwords, tokens, or writing either database.

- [x] **Step 2: Do not switch login yet**

  Login cutover requires a separate plan after the real production PostgreSQL compatibility check, password-hash compatibility check, and one-account rollback rehearsal.

### Task 5: Prepare legacy password verification without activating migration

**Files:**
- Create: `server/adapters/postgres/password-compat-schema.ts`
- Modify: `server/adapters/password.ts`
- Test: `tests/unit/legacy-password.test.ts`

- [x] Added a checksum migration allowing `pbkdf2_sha256` during the migration window and a bounded legacy verifier. The verifier preserves the central scrypt path, limits PBKDF2 iterations, and shares the existing concurrency guard.
- [x] Verified legacy PBKDF2 and central scrypt with 2/2 unit tests and `npm.cmd run typecheck`.
- [x] Kept the compatibility path inactive for account import and login cutover; a separate authentication migration plan is still required.

### Task 6: Add explicit legacy account mapping storage

**Files:**
- Create: `server/core/legacy-account-mapping.ts`
- Create: `server/adapters/postgres/legacy-account-mapping-schema.ts`
- Modify: `server/adapters/postgres/auth-repository.ts`
- Test: `tests/unit/account-domain-contracts.test.ts`, `tests/integration/account-domain-schema.test.ts`

- [x] Added `identity.legacy_account_mappings` with explicit statuses and nullable center UUID.
- [x] Kept password hashes, sessions, and tokens out of the mapping table.
- [x] Verified migration idempotency and foreign-key cleanup in the isolated PostgreSQL test.

### Task 7: Authentication migration gate

- [x] Generate a per-account read-only mapping preview from the real Navigator database.
- [x] Review duplicate/blank display names and accounts without password hashes.
- [x] Run a one-account isolated migration rehearsal with rollback.
- [ ] Only after those checks, activate the old PBKDF2 verification branch for a controlled migration window. The isolated rehearsal is complete; this remains intentionally gated because it would change the real login path.

