# Contact Change Schema Repair Design

## Goal

Restore QA4 center startup when CRM tables live in `prospector` and identity
tables live in `public`, while retaining compatibility with legacy local centers
that keep both groups of tables in `public`.

## Root Cause

The contact-change migration creates and reads CRM tables through the configured
`search_path`. Its follow-up migration `063-public-outbox-fk-repair` instead
hard-codes four CRM tables under `public`. QA4 correctly configures
`search_path=prospector,public`, so the four tables exist only in `prospector` and
the repair transaction fails before recording migration `063`.

## Design

Keep the identity target explicit as `public.identity_outbox`, but resolve the
four CRM source tables through the connection search path:

- `crm_contact_changes`
- `crm_event_deliveries`
- `crm_notification_consumed`
- `crm_task_due_receipts`

This uses the existing database ownership contract instead of adding runtime
schema discovery. QA4 resolves the names from `prospector`; legacy local centers
with the existing default path resolve them from `public`. Hard-coding
`prospector` is rejected because it would break the legacy layout. Dynamic
catalog lookup is rejected because it duplicates connection configuration and
adds ambiguity when both schemas contain a stale table.

The migration version remains `063-public-outbox-fk-repair`. QA4 has not
recorded that version, so it can execute the corrected SQL normally. Existing
databases that already recorded `063` keep the original SQL checksum; the
repository accepts that exact historical checksum as well as the corrected SQL
checksum, while continuing to reject every other drift value.

## Failure Handling

The existing transaction and advisory lock remain unchanged. Any missing CRM
table, missing identity target, or foreign-key validation error rolls back the
entire repair and leaves migration `063` unrecorded. Logs must not include
credentials or row data.

## Verification

- A focused test must fail while the repair SQL hard-codes `public.crm_*` and
  pass when CRM table names are resolved by `search_path`.
- The same test must accept the exact historical `063` checksum and the current
  checksum, while rejecting an unrelated checksum.
- Existing single-schema integration behavior must remain valid.
- The prebuilt online server bundle must contain the same corrected SQL and pass
  `node --check`.
- QA4 must record migration `063`, start without `contact-change.pg`, and become
  Ready after a new image is deployed.

