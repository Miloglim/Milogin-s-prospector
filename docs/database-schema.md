# Prospector Database Schema

## Current Authority

Production uses SQLite through Drizzle ORM and `better-sqlite3` in WAL mode. The database is stored at `data/prospector.db` beneath Electron `userData` in a packaged build and beneath the project root in development.

`src/main/db/schema-sql.ts` is the executable schema source shared by production migrations and evaluation sandboxes. `src/main/db/schema/*.ts` supplies the typed Drizzle definitions. `src/main/db/index.ts` owns idempotent migrations for existing installations. This document is a map of the current model, not a second DDL source.

## Sales Data

| Table | Purpose | Key fields |
|---|---|---|
| `companies` | Company profile and research data | `name`, `domain`, `country`, `backcheck_data` |
| `contacts` | Prospect and customer contacts | `email`, `company_id`, `stage`, `status`, `client_type`, `tags` |
| `crm_stages` | Current CRM stage and reminder for a contact | `contact_id`, `stage`, `reminder_at` |
| `crm_relations` | Contact-to-contact relationships | `contact_id_a`, `contact_id_b`, `relation_type` |
| `interactions` | Immutable contact timeline entries | `contact_id`, `type`, `direction`, `channel`, `metadata` |
| `templates` | Versioned email templates | `name`, `language`, `subject`, `body`, `version` |

`contacts.email` is the primary mailbox-matching identity. Interaction records provide the communication history; do not infer a contact state solely from a UI label.

## Mail Delivery and Inbox

| Table | Purpose | Key fields |
|---|---|---|
| `email_accounts` | Configured sending and receiving accounts | `email`, SMTP/IMAP settings, encrypted password, circuit-breaker state |
| `send_block_events` | Auditable reasons a sender is blocked | `account_id`, `reason`, `created_at` |
| `send_queue` | Legacy and standalone delivery queue | `contact_id`, `account_id`, `status`, `scheduled_at`, `error_kind` |
| `send_campaigns` | Campaign definition and lifecycle | `name`, `status`, `sequence_json`, `started_at`, `completed_at` |
| `send_campaign_targets` | Per-contact campaign progress | `campaign_id`, `contact_id`, `status`, `next_touch_at`, `last_error` |
| `inbox_messages` | Imported incoming and sent-mail headers and previews | `account_id`, `message_id`, `from_email`, `classification`, `intent`, `matched_contact_id` |
| `inbox_bounce_matches` | Bounce-to-contact reconciliation | `message_id`, `contact_id`, `created_at` |

The application stores mail previews and metadata in the database. Message bodies are handled by the inbox services and are not represented by the obsolete `raw_source` column described in earlier versions of this document.

## Agent Control Plane

| Table | Purpose | Key fields |
|---|---|---|
| `agent_conversations` | Conversation metadata | `id`, `title`, `created_at`, `updated_at` |
| `agent_messages` | Persisted user and assistant messages | `conversation_id`, `role`, `content` |
| `agent_tool_calls` | Tool-call audit trail | `conversation_id`, `tool_name`, `arguments`, `result`, `status` |
| `agent_gaps` | Evidence or workflow gaps raised by the agent | `conversation_id`, `kind`, `status`, `payload` |
| `agent_suggestions` | Retained suggestion records for migration compatibility | `day`, `payload` |
| `agent_facts` | Persisted extracted facts | `conversation_id`, `fact`, `source` |
| `agent_working_memory` | Bounded structured context replayed during an agent session | `conversation_id`, `kind`, `payload`, `created_at` |

## Rate Data

| Table | Purpose | Key fields |
|---|---|---|
| `rate_quotes` | Quoted freight rates | `record_id`, `lane`, `carrier`, `valid_from`, `valid_to`, `source_group`, `msg_time` |
| `space_records` | Capacity and space observations | `record_id`, `lane`, `pod_raw`, `space_type`, `msg_time`, `source_group` |

The raw mirror remains the source of record. Query-side cleaning derives a presentation model and must preserve its source reference.

## Migration Rules

1. Change the typed Drizzle schema and `schema-sql.ts` together.
2. Add an idempotent named migration in `src/main/db/index.ts` for existing databases.
3. Preserve the production schema contract in `schema-sql.ts`, which evaluation sandboxes also execute.
4. Add or update migration tests before relying on a new column or index.

## Operational Notes

SQLite runs in WAL mode. `saveDatabase()` performs a checkpoint after batches and during shutdown; individual writes are already durable. Backup location and retention are operational configuration, not schema.
