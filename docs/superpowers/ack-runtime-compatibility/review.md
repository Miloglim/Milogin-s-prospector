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
- Jenkins proved that installing curl through apt is not viable because the internal Node image cannot verify the current Debian archive signatures.
- `curl` and its non-system shared libraries are exported from the pinned internal Bookworm tool image; the final image performs no apt operation and validates the copied executable with `curl --version` during build.
- The exporter preserves the Node image's C runtime and dynamic loader instead of overwriting core system libraries.
- The standard log directory is created before the existing recursive ownership change and remains writable by the non-root `node` user.
- The Dockerfile starts the tracked prebuilt bundle, and that bundle contains the new HTTP routes.

## Residual risk

This host has no Docker command, so local checks cannot prove compatibility between the pinned tool stage and the release platform's rewritten registry names. The next Jenkins build must pass both the exporter and final `curl --version` layers before the Pod-level acceptance checks apply.

The shared QA4 template still uses one readiness-backed endpoint for startup, readiness, and liveness. A prolonged database outage can therefore trigger liveness restarts; changing that behavior requires a platform-template change and is outside this repository fix. Only a new QA4 release can confirm the complete platform path.
