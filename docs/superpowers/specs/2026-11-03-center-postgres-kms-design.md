# Center PostgreSQL KMS Design

## Goal

Allow the QA4 Prospector center to consume the company-standard Apollo
`postgres.password` KMS secret name and connect to the fixed
`milogin_center` database without storing a plaintext database password in
Apollo.

## Design

Add a focused PostgreSQL credential resolver beside the existing PostgreSQL
configuration adapter. In production, `PROSPECTOR_CENTER_PG_KMS_SECRET` is the
environment-safe key used by QA4; `postgres.password` remains a compatible
fallback because some runtimes expose dotted keys directly. The selected value
is treated as a KMS secret name. The resolver calls the company KMS endpoint
using `YQN_APOLLO_CLUSTER` and `YQN_APOLLO_APP_ID`/`APP_PORT`, validates the
response, extracts `AccountName` and `AccountPassword`, and passes an ephemeral
environment overlay to the existing strict database configuration parser.

The KMS path takes precedence over legacy plaintext or DSN inputs when the
standard Apollo key is present. Existing local/test behavior and legacy
production inputs remain unchanged. Errors identify the failed configuration
boundary without including a secret name, password, or raw KMS response.

## Runtime Flow

1. `online.ts` reads the normal HTTP runtime configuration.
2. The database resolver detects the environment-safe KMS key or its dotted
   compatibility fallback.
3. It retrieves the credential from KMS and injects only the returned username
   and password into an in-memory copy of the environment.
4. The existing parser validates host, port, fixed database, search path, and
   application name before the PostgreSQL pool is created.

## Verification

- Unit tests prove KMS credentials override stale legacy values.
- Unit tests prove missing KMS metadata and malformed credentials fail with
  sanitized errors.
- The focused configuration tests pass and esbuild parses the full server entry.
- The prebuilt server bundle is synchronized with the KMS adapter and passes a
  Node syntax check. A full repository build remains pending because this
  isolated worktree has no installed dependencies.
- Apollo QA4 publishes `PROSPECTOR_CENTER_PG_KMS_SECRET=pg-data.qax.root`; the
  compatible `postgres.password` key may remain present, while the obsolete
  literal password configuration is no longer used.
- After deployment, a fresh instance loads the release and `/health/ready`
  succeeds.
