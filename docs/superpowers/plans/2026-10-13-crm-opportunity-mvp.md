# CRM Opportunity MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 将客户关系阶段与单次货运需求的商机阶段分离，支持同一客户多条航线独立推进、阶段留痕和成交证据。

**Architecture:** 复用现有中心 PostgreSQL、统一身份权限、Result 返回、HTTP/桌面 IPC 和 outbox。新增 `crm_opportunities` 与追加式 `crm_opportunity_stage_history`，活动和跟进任务通过可选 `opportunity_id` 关联；不新增 `crm_deals`，`closed_won` 作为商机成交事实状态。

**Tech Stack:** TypeScript、PostgreSQL、Electron IPC、React、Ant Design、Vitest。

**Spec:** `docs/crm-model-review-20261012.md` 与本次已批准的 Opportunity 方案。

## Global Constraints

- 不回填历史假商机；现有 `crm_customers.relationship_stage` 继续表示客户关系阶段。
- 一个商机代表一条独立业务需求/航线；同客户多条航线必须拆成多条商机。
- 所有写入使用幂等键、乐观版本和中心事务；事件与业务写入同事务进入 outbox。
- 服务端重新计算客户访问权限，前端角色和 `customer_id` 不能扩大范围。
- 不新增第三方依赖；不创建第二个 CRM 数据库；不写入本地 SQLite CRM 主数据。

---

### Task 1: Opportunity core contract and migration

**Files:**
- Create: `server/core/opportunities.ts`
- Create: `server/adapters/postgres/opportunity-schema.ts`
- Existing migrations are immutable; associations belong to the new 018 migration.
- Test: `tests/unit/opportunity-service.test.ts`

**Interfaces:**
- Produces `OPPORTUNITY_ROUTES`, `OPPORTUNITY_LIMITS`, `OpportunityStage`, `OpportunityCreate`, `OpportunityUpdateStage`, `OpportunityQuery`, `Opportunity`, `OpportunityPage`, and `OpportunityRepository`.
- Produces migration `018-opportunities` with `crm_opportunities` and `crm_opportunity_stage_history`.

- [x] Write failing tests for valid stage transitions, same customer with two opportunity rows, required customer foreign key, and append-only stage history.
- [x] Run `npx vitest run tests/unit/opportunity-service.test.ts --maxWorkers=1 --minWorkers=1` and observe missing module/contract failure.
- [x] Implement constants and types with explicit route/container/stage limits. Use stages `inquiry`, `quote_sent`, `negotiation`, `booking_confirmed`, `closed_won`, `closed_lost`.
- [x] Implement migration with UUID primary key, customer foreign key, derived current owner projection and creator/closed-by references, route fields (`pol`, `pod`, `container_type`), amount/currency, lost reason, evidence text, version/timestamps, and append-only stage history.
- [x] Run the unit tests and the isolated PostgreSQL migration test; verify migration is idempotent and does not backfill existing customers.

### Task 2: Opportunity service, repository, HTTP, and IPC

**Files:**
- Create: `server/services/opportunities.ts`
- Create: `server/adapters/postgres/opportunity-repository.ts`
- Create: `server/transport/opportunities-http.ts`
- Modify: `server/online.ts`
- Existing CRM handler remains unchanged; online router dispatches the new handler.
- Modify: `src/shared/online-crm.ts`
- Reuse the existing generic authenticated adapter request; no duplicate opportunity transport.
- Modify: `src/main/services/online-crm.service.ts`
- Modify: `src/main/transport/online-crm.ipc.ts`
- Tests: `tests/unit/opportunities-http.test.ts`, `tests/integration/opportunities.test.ts`, `tests/unit/online-ipc-contract.test.ts`, `tests/unit/online-crm.test.ts`

**Interfaces:**
- HTTP: `GET/POST /api/crm/opportunities`, `GET /api/crm/opportunities/:id`, `POST /api/crm/opportunities/:id/stage`.
- IPC: `online:opportunity-list`, `online:opportunity-create`, `online:opportunity-detail`, `online:opportunity-stage`.
- All returns use the existing `Result<T>` contract.

- [x] Write failing tests for invalid customer UUID, forbidden customer scope, duplicate idempotency request, version conflict, two opportunities on one customer, and valid stage-history event.
- [x] Run the focused tests and verify missing route/handler failures.
- [x] Implement service validation, repository transactions, access checks inherited from the customer, and idempotency through `crm_lead_idempotency` with operation-specific keys.
- [x] Implement stage transition validation: no transition out of `closed_won`/`closed_lost` without an explicit reopen command; stage change writes history and outbox in the same transaction.
- [x] Wire HTTP and IPC constants through the existing adapter path; do not add direct renderer HTTP.
- [x] Run all focused tests and the architecture checker.

### Task 3: Activity and task association

**Files:**
- Modify: `server/core/leads.ts`
- Modify: `server/core/tasks.ts`
- Associations are added in `server/adapters/postgres/opportunity-schema.ts`; previous migrations remain unchanged.
- Modify: `server/adapters/postgres/lead-repository.ts`
- Modify: `server/adapters/postgres/task-repository.ts`
- Modify: `src/renderer/pages/customers/FollowupTasks.tsx`
- Tests: existing followup/task tests plus new opportunity association cases.

**Interfaces:**
- `FollowupRequest.opportunityId?: string` and `TaskCreate.opportunityId?: string` are optional.
- The opportunity must belong to the same customer and remain visible to the current actor.

- [x] Add failing tests that reject a cross-customer opportunity and preserve customer-level activity/task behavior when the field is omitted.
- [x] Add nullable `opportunity_id` foreign keys and indexes without altering existing rows.
- [x] Validate association in service/repository transactions and include opportunity summary in detail responses where available.
- [x] Keep the current “下一步” UI working for customer-level tasks; associate a task with the opportunity selected through its followup action; cancellation restores customer-level tasks.
- [x] Run the full customer followup and task regression suites.

### Task 4: Customer detail opportunity surface

**Files:**
- Create: `src/renderer/pages/customers/Opportunities.tsx`
- Modify: `src/renderer/pages/customers/CustomersPage.tsx`
- Modify: `src/renderer/pages/customers/customers.css`
- Test: `tests/integration/customer-opportunity-renderer.test.tsx`

**Interfaces:**
- The detail drawer shows a compact opportunity list under the existing customer profile.
- It supports create, stage update, and evidence display; it does not expose unimplemented CRM/deal controls.

- [x] Write failing renderer tests for two independent opportunities on one customer, stage update, and no cross-customer leakage.
- [x] Implement the compact list using the shared online IPC contract and current visual shell.
- [x] Add only necessary labels and empty states; do not add teaching copy or a new top-level navigation item.
- [x] Run renderer tests and a production build.

### Task 5: Documentation, checkpoint, and acceptance

**Files:**
- Modify: `docs/IPC契约.md`
- Modify: `docs/架构基底.md`
- Modify: `docs/版本记录.md`
- Modify: `D:/Obisian DB/Database/项目/Prospector/当前状态.md`
- Modify: `D:/Obisian DB/Database/项目/Prospector/审阅记录.md`

- [x] Record new IPC/HTTP/schema contracts and the pre-change checkpoint.
- [x] Run `npm run typecheck`, `npm run build`, `npm run check`, focused tests, and isolated PostgreSQL integration tests.
- [x] Manually verify one customer with two opportunities, independent stage transitions, activity/task association, permissions, conflict retry, and outbox notification.
- [x] Run `python D:/Obisian DB/Database/scripts/check_vault.py` and record the remaining boundary: historical opportunities are not inferred and real production data is not backfilled.

## Implementation decisions and evidence

Approved node implemented. Current owner is derived from customer ownership; evidence is a bounded textual business reference. Stage actions use POST; four IPC channels include authorized detail for pagination-independent deep links. Actual node acceptance, test outcomes and remaining boundaries are documented in `docs/b4-opportunity-delivery-20261013.md`; checklist tasks are marked only after final verification.
