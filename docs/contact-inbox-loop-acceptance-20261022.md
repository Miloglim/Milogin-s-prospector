# Contact / Inbox Core Loop Acceptance

## Purpose

This checklist covers the user-visible loop: inbox matching -> contact creation or reactivation -> mailbox return -> matching again. It exists because a successful API response alone does not prove the loop is closed. Local projections, soft deletion, idempotency and renderer cache can each make an old state reappear.

## Invariants

1. A soft-deleted contact is not an active duplicate. It still owns the normalized email's unique index entry and must be restored, not copied into a second row.
2. Restoration requires the actor to retain delete authority over the original contact and compatible customer ownership. Unauthorized restoration must not create a guessed company or empty customer as a side effect.
3. Restoration keeps the same contact ID and historical activities, increments `crm_contact_version`, and emits `crm.contact.updated` in the same transaction.
4. A terminal import receipt (`created`, `duplicate`, `invalid`, `restricted_conflict`) ends the client idempotency attempt. Only an unknown transport result may reuse the same key.
5. After any CRM write, inbox matching must not use a stale local mirror as authoritative. It may return to the mirror only after a complete baseline replaces it; otherwise it reads the authorized center projection.
6. A successful inbox-originated add returns to the source message and invalidates the `contacts` query before displaying the result again.
7. Unknown recipient or CC addresses do not become add-contact prompts. Only addresses already present in the authorized contact projection appear as additional matches.
8. A center contact delete from the inbox uses the center reference and expected contact version. A same-number legacy ID must never be used.
9. Failures remain failures. An unavailable mirror, center or permission check cannot be rendered as an empty contact list or as “no match”.

## State Matrix

| Current state | User action | Expected result | Forbidden result |
|---|---|---|---|
| Active contact matches mail | Open mail | Contact shown once under the sender or other-contact section | Duplicate sender under both sections |
| Active contact matches mail | Delete from inbox | Confirmed center delete, match refreshes to unmatched | “Not implemented”, legacy integer delete |
| Deleted contact email | Add from unmatched mail as original actor | Same contact ID restored, original customer/company retained, version and outbox updated | Cached duplicate receipt, new duplicate row, guessed empty company |
| Deleted contact email | Add without original delete authority | Explicit restricted conflict with no business-row side effects | Silent restore, company/customer side effect, leaked historical details |
| Deleted contact email | Retry after terminal failure | A new idempotency key is used | Reusing the prior `duplicate` receipt |
| Mirror missing or incomplete | Match mail | Full authorized center pages are read; failure is explicit | Local empty array interpreted as no contacts |
| CRM write just completed | Match mail | Center-live result is used until a full mirror baseline lands | Stale local result re-hides the contact |
| Successful inbox add | Drawer saved | Return to source inbox detail and show refreshed match | Stay on customer list with no confirmation of return |

## Verification Layers

1. Pure logic: pagination, exact-email normalization, duplicate ambiguity, soft-delete state and terminal idempotency behavior.
2. Renderer: sender/body/header matching, one-time sender display, unmatched add deep link, source-message return and center delete confirmation.
3. Isolated PostgreSQL: active duplicate, soft-delete restoration, same ID, customer/company reuse, version increment, outbox, retained history, unauthorized no-side-effect behavior.
4. Real local-center transaction: exercise the target deleted rows, confirm create/restore and event count, then roll back. Never leave synthetic rows or events in the real center.
5. Real Electron user path: log in with the user's own authorized session, delete, add, return and match again. Do not use a test identity to claim a production permission path is verified.

## Change Triggers

Re-run this matrix whenever any of the following changes: contact uniqueness, soft delete lifecycle, mailbox matching, contact mirror format, cache invalidation, import idempotency, inbox add-return route, contact authorization, or contact-change outbox.

## 2026-10-22 Evidence

- 36 renderer, adapter, mailbox and matching tests passed.
- Isolated PostgreSQL verified restoration details and denied restoration without company/customer side effects.
- A real local-center transaction restored contact IDs 11 and 12, confirmed both stayed on the original customer, versions advanced from 2 to 3 and two update events were produced, then rolled back all changes.
- Typecheck, Electron production build and 5/5 architecture checks passed.
- The real Electron user click sequence remains pending because the application was reloaded to the login page after validation.
