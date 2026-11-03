# ACK runtime compatibility test evidence

Date: 2026-11-03

## TDD evidence

- `npx vitest run tests/unit/online-http-actuator.test.ts`
  - RED: 3 failed, 1 passed; both actuator paths returned the existing 404 response.
  - GREEN: 4 passed after implementing the compatibility routes.
- `npx vitest run tests/unit/docker-runtime-contract.test.ts`
  - RED: 1 failed because the Dockerfile did not install `curl` or create the standard log directory.
  - GREEN: 1 passed after updating the Dockerfile.

## Final focused verification

- `npm run typecheck`: passed.
- `npm run crm:pg:build`: passed after adding the missing `ProcessEnv` type annotation to the existing KMS resolution code.
- `npx vitest run tests/unit/online-http-actuator.test.ts tests/unit/docker-runtime-contract.test.ts tests/unit/center-kms-credential.test.ts`: 3 files passed, 11 tests passed.
- `node scripts/build-prospector-prebuilt.mjs`: passed after first generating the worktree-local `dist-admin` with `npm run crm:admin:build`.
- `node --check deploy/prospector-prebuilt/dist-server/adapters/online.cjs`: passed.
- Bundle search confirmed `/actuator/info`, `/actuator/prometheus`, and `prospector_center_up` are present.
- `git diff --check d30e3cf..HEAD`: passed.

## Full-suite result

`npm test -- --run` completed with 1791 passed and 190 skipped tests. It was not fully green: 5 tests failed and 18 additional suites could not collect in this isolated worktree. The observed causes were missing `.work/pg-crm/config.json`, the intentionally skipped Electron install, and test-only filesystem/runtime assumptions such as `/synthetic`. The new ACK tests passed in this run. These environment failures are outside the deployment compatibility change and are not reported as passing.

## Remaining environment verification

- Docker image build was not run because this host has no `docker` command.
- QA4 Pod readiness is not proven locally. After release, acceptance requires no lifecycle-hook failures, `Ready 1/1`, zero restart growth, and successful actuator probe/scrape responses.
