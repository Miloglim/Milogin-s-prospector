# ACK Runtime Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Prospector center image pass the company QA4 lifecycle hooks, actuator probes, and Prometheus scrape contract.

**Architecture:** Keep `/health/live` and `/health/ready` as the native product API and add a small adapter in the existing HTTP transport for the platform-owned `/actuator/*` paths. Make the Docker image explicitly provide the lifecycle hook dependency and writable standard log directory while preserving the existing non-root runtime.

**Tech Stack:** Node.js 22 HTTP server, TypeScript, Vitest, Debian slim Docker image

---

### Task 1: Actuator compatibility routes

**Files:**
- Modify: `server/transport/http.ts`
- Create: `tests/unit/online-http-actuator.test.ts`

- [ ] **Step 1: Write failing HTTP contract tests**

Create a real ephemeral `createOnlineServer` instance with a minimal `AuthService` stub. Assert:

```ts
expect(await get('/actuator/info')).toMatchObject({
  status: 200,
  contentType: 'application/json; charset=utf-8',
  body: { status: 'UP' },
});
expect(await head('/actuator/info')).toMatchObject({ status: 200, text: '' });
expect(await get('/actuator/prometheus')).toMatchObject({
  status: 200,
  contentType: 'text/plain; version=0.0.4; charset=utf-8',
});
```

Add a second server whose `ready()` returns `failure('UNAVAILABLE', ...)` and assert `GET` and `HEAD /actuator/info` return 503.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npx vitest run tests/unit/online-http-actuator.test.ts
```

Expected: FAIL because `/actuator/info` and `/actuator/prometheus` currently return the generic 404 result.

- [ ] **Step 3: Implement minimal operational response helpers**

In `server/transport/http.ts`, add focused helpers that:

```ts
const ACTUATOR_INFO_PATH = '/actuator/info';
const ACTUATOR_PROMETHEUS_PATH = '/actuator/prometheus';
```

- call `service.ready()` for GET/HEAD actuator info;
- return `{"status":"UP"}` with HTTP 200 only when readiness succeeds;
- reuse `HTTP_STATUS[result.error.code]` for readiness failures;
- omit the body for HEAD;
- return Prometheus text containing `prospector_center_up 1` with the standard text exposition content type;
- set `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and `Connection: close` on operational responses.

Route these paths after Host validation and before browser/auth dispatch. Do not alter the native health branches.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
npx vitest run tests/unit/online-http-actuator.test.ts
```

Expected: all actuator contract tests pass.

- [ ] **Step 5: Commit HTTP compatibility**

```bash
git add server/transport/http.ts tests/unit/online-http-actuator.test.ts
git commit -m '[部署] 兼容ACK actuator探针'
```

### Task 2: Container lifecycle contract

**Files:**
- Modify: `Dockerfile`
- Create: `tests/unit/docker-runtime-contract.test.ts`

- [ ] **Step 1: Write failing Dockerfile contract test**

Read the repository `Dockerfile` as text and assert it contains:

```ts
expect(source).toContain('apt-get install -y --no-install-recommends curl');
expect(source).toContain('/opt/web/ws-${APP_PORT}/logs');
expect(source).toContain('chown -R node:node');
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run tests/unit/docker-runtime-contract.test.ts
```

Expected: FAIL because the current image does not install curl or precreate the log directory.

- [ ] **Step 3: Implement the Docker runtime contract**

Extend the existing root setup layer to:

```dockerfile
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/web/ws-${APP_PORT}/logs /var/lib/prospector-center \
    && chmod -R 755 /opt/web \
    && chmod 1777 /tmp
```

Keep the existing post-copy `chown -R node:node` so the standard directory is writable by the non-root runtime.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
npx vitest run tests/unit/docker-runtime-contract.test.ts
```

Expected: the Docker runtime contract test passes.

- [ ] **Step 5: Commit image compatibility**

```bash
git add Dockerfile tests/unit/docker-runtime-contract.test.ts
git commit -m '[部署] 补齐ACK生命周期依赖'
```

### Task 3: Full verification and delivery evidence

**Files:**
- Create: `docs/superpowers/ack-runtime-compatibility/test.md`
- Create: `docs/superpowers/ack-runtime-compatibility/review.md`

- [ ] **Step 1: Run source verification**

Run:

```bash
npm run typecheck
npm test -- --run
npm run crm:pg:build
git diff --check HEAD~2
```

Expected: all commands exit 0 with no test failures or whitespace errors.

- [ ] **Step 2: Record test evidence**

Write the command, date, exit result, and relevant pass counts to `test.md`. Explicitly state that a real QA4 Pod Ready check requires a new release and is not proven locally.

- [ ] **Step 3: Review the scoped diff**

Review for route exposure, readiness semantics, response headers, Docker layer hygiene, non-root permissions, unrelated changes, and secrets. Record findings or `No findings` in `review.md`.

- [ ] **Step 4: Commit verification evidence**

```bash
git add docs/superpowers/ack-runtime-compatibility/test.md docs/superpowers/ack-runtime-compatibility/review.md
git commit -m '[部署] 记录ACK兼容验证结果'
```

- [ ] **Step 5: Push the approved branch**

```bash
git push origin codex/center-postgres-kms
```

Expected: the remote branch advances to the local HEAD. QA4 acceptance is performed after the user releases that commit.
