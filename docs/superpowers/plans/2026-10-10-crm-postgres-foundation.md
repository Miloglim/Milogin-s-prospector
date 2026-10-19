# CRM PostgreSQL Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 独立测试 PostgreSQL、CRM 表和可直接复用的数据访问层通过真实数据库验证；不切换桌面读写、不接登录或 HTTP API。

**Architecture:** core 为零依赖契约；services 仅校验并调用仓储端口；adapters 实现 PostgreSQL IO、事务和日志。联系人 `tags` 是当前 CRM 阶段来源，不新建竞争的 crm_stages 事实源。中心与桌面仍分阶段连接。

**Tech Stack:** 现有 TypeScript、Vitest、PostgreSQL 18 工具；经此前依赖报告与本轮实施范围确认，新增固定版本 pg 8.23.1、@types/pg 8.23.1。不升级 Drizzle/Electron。

**Spec:** `D:/Agent Basement/designs/prospector-online-20261010/06-局域网验证阶段.md`；2026-10-10 用户选择“先建独立 PostgreSQL 测试库、CRM 表和数据访问层，验证后再接登录/API”。

## Global Constraints

- 用户范围是 PG 基础节点，L0 的账号/API 延后。没有正式迁移或外发权限。
- 统一返回 `{ ok, data?, error? }`；零 IO core/services；API/IPC 先常量和类型（本轮无新增 IPC/HTTP）。
- 魔数命名、时间配置 `_seconds`、分级脱敏日志、禁止空 catch。
- 测试库固定名称 `prospector_crm_test`，独立 cluster/端口及运行目录；禁止误用既有 freightpilot 实例。
- checkpoint：`D:/Agent Basement/checkpoints/prospector-postgres-preflight-20261010-180033`，335 份源码。保留所有其他工作区改动。
- 为独立新增模块在现有目录定向修改，不创建会遗漏当前未提交改动的 checkout，不提交无关修改。

## Task 1: Write the contract and failing real-PG tests

**Files:** Create `server/core/crm.ts`, `tests/integration/crm-postgres.test.ts`.

**Interfaces:** `CrmRepository` exposes createCompany/createContact/getContact/listContacts/addFollowup/changeStage/listInteractions. `Result<T>` is a discriminated union. Contact and interaction row types use numbers for generated IDs, ISO strings for time, arrays/objects for JSONB. Contract has named valid CRM stage values.

- [x] Define types and expected methods before implementation.
- [x] Write integration tests for foreign keys, case-insensitive unique email, parameterized hostile text, JSON round-trip, stage/activity atomicity, failed writes rollback, migration idempotency and multiple connections seeing one committed state.
- [x] Run `npm run crm:pg:test`; observe missing adapter/runtime failure before production implementation.

Test shape:
```ts
const stage = await service.changeStage(contact.id, "quoting");
expect(stage.ok).toBe(true);
expect((await service.getContact(contact.id)).data?.tags).toEqual(["quoting"]);
expect((await service.listInteractions(contact.id)).data?.[0]?.type).toBe("stage");
```

## Task 2: Isolated PostgreSQL and repository implementation

**Files:** Create `scripts/crm-postgres.mjs`, `server/adapters/postgres/{schema,repository,config}.ts`, `server/adapters/logger.ts`, `server/services/crm.ts`, `server/cli.ts`, `tsconfig.server.json`; update `package.json`, lockfile, `.gitignore`.

**Interfaces:** runtime `start/status/stop` validates marker, exact test DB, data directory and loopback port before reusing a cluster. It generates local test credentials and never prints them. Compiled CLI reads validated configuration; repository exposes `migrate(): Promise<Result<void>>`, injected Pool plus LogSink, and core methods. Services return repository Results after input validation; adapters own errors and IO.

- [x] Install only approved drivers, fixed versions, with lifecycle scripts disabled; preserve native Electron ABI bindings.
- [x] Create reversible independent PG runtime using installed initdb/pg_ctl; configuration and password files excluded from Git, restrict local access, remove temporary initialization password file.
- [x] Create versioned transactional schema: companies, contacts, interactions and crm_relations, indexes and relational constraints. Store stage in contacts.tags; no separate active stage table. Require stable migration checksum and an advisory transaction lock.
- [x] Implement parameterized asynchronous queries, whitelisted stage values, contact existence checks and atomic stage/activity changes. Use SQL transaction rollback on errors and release clients.
- [x] Run tests against real test PG; use repeat migration and a separate Pool to verify persisted visibility.

## Task 3: Runtime delivery, regression and documentation

**Files:** update `docs/架构基底.md`, `docs/版本记录.md`, add `docs/crm-postgres-foundation.md`; feature minor version `0.10.0-alpha.1`. Sync project current state and aggregate review in the knowledge vault after reading its maintenance rules.

- [x] Run independent `crm:pg:start`, server typecheck/build, CLI migration/health smoke, `crm:pg:test` and stop/start repeat smoke.
- [x] Run existing typecheck, architecture checker/checker tests and desktop build; affected existing CRM regression tests if present. Do not run live agent evaluations or SMTP.
- [x] Check owned diff, checkpoint hashes and forbidden runtime files in Git status. Record measured results and unresolved limitations.
- [x] Update plan checkboxes and save delivery manifest. Knowledge-vault check remains read-only except explicitly required project state/review synchronization.

Completion means executable/tested PG foundation, not desktop migration, real data import, SSO, notifications or online sending. Next implementation report covers the minimum identity/API layer using this repository.

## Measured delivery

2026-10-10: real PostgreSQL dedicated suite 10/10; normal regression 754 passed / 40 skipped (the dedicated PG suite accounts for 10 of the skipped tests and was separately executed). Server compilation/CLI migration, desktop typecheck, architecture checker (src scope), 5 checker tests, and desktop build passed. Independent PG stop/start smoke passed. Snapshot hashes 335/335 valid; existing src hashes unchanged. Existing postgres-freightpilot service remains Running. Runtime credentials and dist-server ignored by Git. Knowledge project state/review/aggregate synchronized; unrelated freight source drift retained for its own review. No release, real-data import or desktop database switch.
