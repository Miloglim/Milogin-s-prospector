import { describe, expect, it } from 'vitest';
import {
  PUBLIC_OUTBOX_FK_REPAIR_CHECKSUM,
  PUBLIC_OUTBOX_FK_REPAIR_LEGACY_CHECKSUM,
  PUBLIC_OUTBOX_FK_REPAIR_SQL,
  acceptsPublicOutboxFkRepairChecksum,
} from '../../server/adapters/postgres/contact-change-schema';

describe('contact change schema repair', () => {
  it('resolves CRM tables through search_path while keeping the identity target public', () => {
    const tables = [
      'crm_contact_changes',
      'crm_event_deliveries',
      'crm_notification_consumed',
      'crm_task_due_receipts',
    ];

    for (const table of tables) {
      expect(PUBLIC_OUTBOX_FK_REPAIR_SQL).toContain(`ALTER TABLE ${table} DROP CONSTRAINT`);
      expect(PUBLIC_OUTBOX_FK_REPAIR_SQL).not.toContain(`ALTER TABLE public.${table}`);
    }
    expect(PUBLIC_OUTBOX_FK_REPAIR_SQL).toContain('REFERENCES public.identity_outbox(event_id)');
  });

  it('accepts the recorded checksum from the original public-only repair', () => {
    expect(PUBLIC_OUTBOX_FK_REPAIR_LEGACY_CHECKSUM).toBe('7a3939109d14312734c707f91bb670ad5def20f3cbaa65cec428d26611ea50b6');
    expect(acceptsPublicOutboxFkRepairChecksum(PUBLIC_OUTBOX_FK_REPAIR_CHECKSUM)).toBe(true);
    expect(acceptsPublicOutboxFkRepairChecksum(PUBLIC_OUTBOX_FK_REPAIR_LEGACY_CHECKSUM)).toBe(true);
    expect(acceptsPublicOutboxFkRepairChecksum('invalid')).toBe(false);
  });
});
