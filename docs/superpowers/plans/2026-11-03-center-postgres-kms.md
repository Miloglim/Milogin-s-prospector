# Center PostgreSQL KMS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the company-standard Apollo PostgreSQL KMS credential before the Prospector center creates its production database pool.

**Architecture:** A focused async KMS adapter returns a validated username/password pair. The online entry point overlays those ephemeral values onto the environment and reuses the existing strict PostgreSQL configuration parser.

**Tech Stack:** TypeScript, Node.js 22 built-ins (`crypto`, `fetch`), Vitest, PostgreSQL `pg`, esbuild.

---

### Task 1: KMS credential resolver

**Files:**
- Create: `server/adapters/postgres/kms-credential.ts`
- Create: `tests/unit/center-kms-credential.test.ts`

- [x] Add a failing unit test that supplies `postgres.password`, mocked KMS transport, and stale legacy credentials, then expects the KMS `AccountName` and `AccountPassword` to win.
- [x] Run the focused test and confirm the new exported resolver is missing.
- [x] Implement signed KMS retrieval using `YQN_APOLLO_CLUSTER` and `YQN_APOLLO_APP_ID || APP_PORT`, strict response validation, and sanitized errors.
- [x] Add failure tests for missing metadata and incomplete credentials.
- [x] Re-run the focused unit test and confirm all cases pass.

### Task 2: Online startup integration

**Files:**
- Modify: `server/adapters/postgres/config.ts`
- Modify: `server/online.ts`
- Modify: `tests/unit/center-kms-credential.test.ts`

- [x] Add a failing test showing the async production resolver returns a pool configuration for the KMS username and fixed `milogin_center` database.
- [x] Add `resolveOnlineDatabaseConfig` while retaining existing synchronous readers for local and legacy callers.
- [x] Await the resolver before constructing the online PostgreSQL pool.
- [x] Add a regression test for a KMS-resolved pool without the legacy plaintext password.
- [x] Add a regression test for QA4 filtering dotted Apollo keys and support `PROSPECTOR_CENTER_PG_KMS_SECRET`.
- [x] Run the focused tests and an esbuild parse of the full server entry.
- [ ] Run `npm run crm:pg:build` after project dependencies are available.

### Task 3: Deployment artifact and QA4 configuration

**Files:**
- Modify: `deploy/prospector-prebuilt/dist-server/adapters/online.cjs`
- Modify: `deploy/prospector-prebuilt/SOURCE_COMMIT.txt` only when produced by the repository build script.

- [x] Synchronize the deployment bundle manually because the isolated worktree has no installed `pg` dependency; do not install dependencies implicitly.
- [x] Confirm the bundle includes `postgres.password`, the KMS endpoint path, and no live decrypted password value.
- [x] Publish `postgres.password=pg-data.qax.root` in Apollo app `22124`, environment `QA4`, cluster `qa4`.
- [x] Publish the environment-safe `PROSPECTOR_CENTER_PG_KMS_SECRET=pg-data.qax.root` key after confirming QA4 filters dotted keys.
- [x] Ensure the obsolete literal password key is not selected by the new resolver.
- [ ] Verify an instance loads the latest release and both `/health/live` and `/health/ready` succeed.

### Task 4: Container direct-start identity

**Files:**
- Create: `server/adapters/online-instance.ts`
- Create: `tests/unit/online-instance.test.ts`
- Modify: `server/online.ts`
- Modify: `deploy/prospector-prebuilt/dist-server/adapters/online.cjs`

- [x] Confirm the latest KMS-enabled Pod passes database authentication and fails at the missing instance identifier boundary.
- [x] Add a failing test for direct container startup without `PROSPECTOR_ONLINE_INSTANCE`.
- [x] Generate a per-process 64-character identifier only when the variable is absent.
- [x] Keep explicit valid identifiers and reject explicit invalid values.
- [x] Synchronize the prebuilt deployment bundle.
- [ ] Deploy and verify the QA4 Pod becomes ready.
