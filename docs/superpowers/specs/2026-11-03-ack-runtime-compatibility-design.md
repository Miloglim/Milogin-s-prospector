# ACK runtime compatibility design

## Goal

Make the Prospector center image satisfy the company QA4 release template without
changing the shared Jenkins or Kubernetes configuration. The existing native
health endpoints remain the product contract; the new endpoints are deployment
compatibility adapters.

## Confirmed deployment contract

The QA4 Pod template:

- executes `curl` from `postStart` and `preStop` lifecycle hooks;
- creates `/opt/web/ws-${APP_PORT}/logs` after the `postStart` request;
- probes `GET /actuator/info` for startup, liveness, and readiness;
- scrapes `GET /actuator/prometheus` as Prometheus text.

The current image lacks `curl`, `/actuator/info`, and
`/actuator/prometheus`. The application reaches its ready log message, but the
failed `postStart` hook causes Kubelet to terminate it.

## Design

### Image contract

The Dockerfile will install `curl` from the internal base image's Debian
repositories. It will create the standard log directory during the image build
and keep it writable by the existing non-root `node` user. The existing internal
base image, build arguments, work directory, dynamic port, and non-root runtime
remain unchanged.

### HTTP compatibility contract

The center HTTP transport will expose:

- `GET /actuator/info`: call the same readiness service used by
  `/health/ready`; return HTTP 200 with `status: "UP"` only when ready, and
  preserve the existing readiness failure status otherwise;
- `HEAD /actuator/info`: use the same readiness decision without a response
  body;
- `GET /actuator/prometheus`: return valid Prometheus text with a minimal
  process-up gauge and the required content type.

These routes are public operational endpoints and run before authentication,
like the existing health endpoints. Existing Host and cross-site request checks
remain in force. No credentials or business data are exposed.

### Native health contract

`/health/live` and `/health/ready` remain unchanged and continue to serve local
operations and product-specific diagnostics. The actuator routes do not replace
them.

## Verification

Automated tests will cover ready and unavailable actuator responses, HEAD body
behavior, Prometheus syntax/content type, and the unchanged native health
routes. Dockerfile contract checks will verify `curl` installation, log-directory
creation, and ownership.

After a QA4 release, acceptance requires:

- no `FailedPostStartHook` or `FailedPreStopHook` event;
- `GET /actuator/info` returns 200 after database readiness;
- the Pod becomes `Ready 1/1` without restarts;
- application logs still report the center service ready;
- `/actuator/prometheus` is scrapeable.

## Non-goals

- registering the Node service as a Eureka client;
- changing the shared Jenkins/Kubernetes release template;
- replacing the existing health API or adding a metrics dependency;
- changing database, Apollo, or KMS behavior.
