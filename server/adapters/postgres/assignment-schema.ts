/** R3 append-only migration: recipient snapshots never change CRM access. */
export const ASSIGNMENT_VERSION='009-directed-assignment';
export const ASSIGNMENT_SQL=`ALTER TABLE identity.outbox ADD COLUMN recipient_user_ids uuid[];`;
