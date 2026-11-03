# Contact Change Schema Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let migration `063-public-outbox-fk-repair` repair CRM foreign keys in both QA4's `prospector,public` layout and legacy single-schema centers.

**Architecture:** Keep `public.identity_outbox` explicit because identity is a shared schema contract. Resolve the four CRM tables through the connection's existing `search_path`, which selects `prospector` in QA4 and `public` in legacy centers.

**Tech Stack:** TypeScript, PostgreSQL DDL, Vitest, esbuild prebuilt bundle, Node.js syntax checks.

---

### Task 1: Lock the schema-resolution contract with a regression test

**Files:**
- Create: `tests/unit/contact-change-schema.test.ts`
- Read: `server/adapters/postgres/contact-change-schema.ts`

- [x] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import {
  PUBLIC_OUTBOX_FK_REPAIR_CHECKSUM,
  PUBLIC_OUTBOX_FK_REPAIR_LEGACY_CHECKSUM,
  PUBLIC_OUTBOX_FK_REPAIR_SQL,
  acceptsPublicOutboxFkRepairChecksum,
} from '../../server/adapters/postgres/contact-change-schema';

describe('contact change schema repair', () => {
  it('resolves CRM tables through search_path while keeping the identity target public', () => {
    const tables = [
      'crm_contact_changes',
      'crm_event_deliveries',
      'crm_notification_consumed',
      'crm_task_due_receipts',
    ];

    for (const table of tables) {
      expect(PUBLIC_OUTBOX_FK_REPAIR_SQL).toContain(`ALTER TABLE ${table} DROP CONSTRAINT`);
      expect(PUBLIC_OUTBOX_FK_REPAIR_SQL).not.toContain(`ALTER TABLE public.${table}`);
    }
    expect(PUBLIC_OUTBOX_FK_REPAIR_SQL).toContain('REFERENCES public.identity_outbox(event_id)');
  });

  it('accepts the recorded checksum from the original public-only repair', () => {
    expect(acceptsPublicOutboxFkRepairChecksum(PUBLIC_OUTBOX_FK_REPAIR_CHECKSUM)).toBe(true);
    expect(acceptsPublicOutboxFkRepairChecksum(PUBLIC_OUTBOX_FK_REPAIR_LEGACY_CHECKSUM)).toBe(true);
    expect(acceptsPublicOutboxFkRepairChecksum('invalid')).toBe(false);
  });
});
```

- [x] **Step 2: Run the test and verify RED**

Run: `npm test -- --run tests/unit/contact-change-schema.test.ts`

Expected: FAIL because the current SQL contains `ALTER TABLE public.crm_contact_changes` and the other three hard-coded CRM table names.

Execution note: the worktree has no Vitest binary, so the same production export
was imported with Node type stripping and the equivalent assertion failed on
`crm_contact_changes` as expected.

### Task 2: Make the repair search-path aware

**Files:**
- Modify: `server/adapters/postgres/contact-change-schema.ts:41`
- Test: `tests/unit/contact-change-schema.test.ts`

- [x] **Step 1: Apply the minimal SQL correction**

Replace only the four CRM table qualifiers; retain the explicit shared identity target:

```sql
ALTER TABLE crm_contact_changes DROP CONSTRAINT IF EXISTS crm_contact_changes_event_id_fkey;
ALTER TABLE crm_contact_changes ADD CONSTRAINT crm_contact_changes_event_id_fkey
  FOREIGN KEY(event_id) REFERENCES public.identity_outbox(event_id);
ALTER TABLE crm_event_deliveries DROP CONSTRAINT IF EXISTS crm_event_deliveries_event_id_fkey;
ALTER TABLE crm_event_deliveries ADD CONSTRAINT crm_event_deliveries_event_id_fkey
  FOREIGN KEY(event_id) REFERENCES public.identity_outbox(event_id);
ALTER TABLE crm_notification_consumed DROP CONSTRAINT IF EXISTS crm_notification_consumed_event_id_fkey;
ALTER TABLE crm_notification_consumed ADD CONSTRAINT crm_notification_consumed_event_id_fkey
  FOREIGN KEY(event_id) REFERENCES public.identity_outbox(event_id);
ALTER TABLE crm_task_due_receipts DROP CONSTRAINT IF EXISTS crm_task_due_receipts_event_id_fkey;
ALTER TABLE crm_task_due_receipts ADD CONSTRAINT crm_task_due_receipts_event_id_fkey
  FOREIGN KEY(event_id) REFERENCES public.identity_outbox(event_id);
```

Also retain the exact checksum derived from the original `public.crm_*` SQL and
accept it beside the corrected checksum, so centers that already recorded `063`
do not fail checksum validation.

- [x] **Step 2: Run the focused test and verify GREEN**

Run: `npm test -- --run tests/unit/contact-change-schema.test.ts`

Expected: 1 test passes.

Execution note: the equivalent direct Node assertion passes; the Vitest command
remains blocked by the absent binary.

- [ ] **Step 3: Run adjacent contact-change tests**

Run: `npm test -- --run tests/unit/contact-change-schema.test.ts tests/unit/contact-change-feed.test.ts`

Expected: all focused unit tests pass.

Execution note: blocked because this isolated worktree has no Vitest binary;
dependencies were not installed. The focused production-export assertions were
executed directly with Node and passed.

### Task 3: Synchronize the deployable server artifact

**Files:**
- Modify: `deploy/prospector-prebuilt/dist-server/adapters/online.cjs:14778`
- Verify: `server/adapters/postgres/contact-change-schema.ts`

- [x] **Step 1: Build the prebuilt artifact when repository dependencies are available**

Run: `node scripts/build-prospector-prebuilt.mjs`

Expected: the command exits zero and rewrites `deploy/prospector-prebuilt/dist-server/adapters/online.cjs`. If the isolated worktree lacks dependencies, update only the matching bundled SQL block from the verified source without installing dependencies.

Execution note: the build command confirmed `esbuild` is absent, so only the
matching bundled SQL block was synchronized as allowed above.

- [x] **Step 2: Verify source and bundle have the same schema behavior**

Run: `rg -n "ALTER TABLE (public\\.)?crm_(contact_changes|event_deliveries|notification_consumed|task_due_receipts)" server/adapters/postgres/contact-change-schema.ts deploy/prospector-prebuilt/dist-server/adapters/online.cjs`

Expected: every CRM `ALTER TABLE` is unqualified in both files.

- [x] **Step 3: Check bundle syntax**

Run: `node --check deploy/prospector-prebuilt/dist-server/adapters/online.cjs`

Expected: exit code 0 with no output.

### Task 4: Record and deliver the fix

**Files:**
- Modify: `docs/prospector-issue-log.md`
- Modify: `docs/superpowers/plans/2026-11-03-contact-change-schema-repair.md`

- [x] **Step 1: Record the user-visible incident**

Append a concise entry covering the QA4 `contact-change.pg` symptom, the hard-coded `public.crm_*` root cause, the search-path-compatible correction, verification performed, and the remaining deployment readiness check.

- [x] **Step 2: Run final repository checks**

Run:

```bash
git diff --check
node --check deploy/prospector-prebuilt/dist-server/adapters/online.cjs
npm test -- --run tests/unit/contact-change-schema.test.ts tests/unit/contact-change-feed.test.ts
```

Expected: all commands exit zero. If project dependencies are unavailable, report that test command as blocked rather than installing dependencies; the syntax and diff checks must still pass.

Execution note: `git diff --check`, bundle syntax, schema behavior, and exact
historical checksum checks pass. The Vitest command is blocked by the missing
binary as recorded above.

- [x] **Step 3: Review the scoped diff**

Run: `git diff -- server/adapters/postgres/contact-change-schema.ts tests/unit/contact-change-schema.test.ts deploy/prospector-prebuilt/dist-server/adapters/online.cjs docs/prospector-issue-log.md docs/superpowers/plans/2026-11-03-contact-change-schema-repair.md`

Expected: only the approved migration compatibility fix, regression test, synchronized artifact, issue record, and plan status are present.

Execution note: independent review reported no actionable findings. It confirmed
source/bundle parity and both current and historical checksum behavior.

- [ ] **Step 4: Commit and push**

```bash
git add server/adapters/postgres/contact-change-schema.ts tests/unit/contact-change-schema.test.ts deploy/prospector-prebuilt/dist-server/adapters/online.cjs docs/prospector-issue-log.md docs/superpowers/plans/2026-11-03-contact-change-schema-repair.md
git commit -m "[运行时] 修复联系人迁移多模式兼容"
git push origin codex/center-postgres-kms
```

- [ ] **Step 5: Verify QA4 after a new image is deployed**

Confirm the new Pod records migration `063-public-outbox-fk-repair`, no longer logs `contact-change.pg`, and reaches Ready. Do not claim the runtime fix is complete before this deployment evidence exists.

