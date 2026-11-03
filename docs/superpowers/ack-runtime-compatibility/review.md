# ACK runtime compatibility review

Date: 2026-11-03

## Scope reviewed

- Node HTTP actuator and Prometheus compatibility routes.
- Docker lifecycle command and writable log-directory requirements.
- Tracked prebuilt server bundle and source fingerprint.
- Focused tests and the KMS configuration type-only build repair.

## Findings

No findings.

## Review notes

- `/actuator/info` is backed by the existing readiness service and returns 503 when readiness fails.
- HEAD uses the same readiness decision and returns no body.
- `/actuator/prometheus` exposes only a process-up gauge and no credentials or business data.
- Existing Host and cross-site checks still apply before operational responses.
- Existing `/health/live` and `/health/ready` behavior is unchanged.
- `curl` is installed with `--no-install-recommends`, and apt indexes are removed in the same layer.
- The standard log directory is created before the existing recursive ownership change and remains writable by the non-root `node` user.
- The Dockerfile starts the tracked prebuilt bundle, and that bundle contains the new HTTP routes.

## Residual risk

The shared QA4 template still uses one readiness-backed endpoint for startup, readiness, and liveness. A prolonged database outage can therefore trigger liveness restarts; changing that behavior requires a platform-template change and is outside this repository fix. The immediate lifecycle failure and missing probe route are addressed, but only a new QA4 release can confirm the complete platform path.
