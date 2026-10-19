import { describe, expect, it } from 'vitest';
import { buildLegacyPersonalImport, legacyContactImportRow } from '../../src/main/core/legacy-contact-sync';

describe('legacy contact import envelope', () => {
  it('preserves personal ownership and maps legacy fields', () => {
    const row = legacyContactImportRow({ localContactId: 7, companyId: 12, companyName: 'Se ara', email: ' A@Example.com ', firstName: 'Ana', lastName: 'Santos', tags: ['reaching'] });
    expect(row).toMatchObject({ customerKey: 'legacy-company-12', companyName: 'Se ara', email: 'a@example.com', firstName: 'Ana', lastName: 'Santos', tags: ['reaching'] });
    expect(row?.rawRow).toEqual({ localContactId: 7, legacySource: 'manual' });
  });

  it('does not create an import row without a usable company or email', () => {
    expect(legacyContactImportRow({ localContactId: 1, companyName: '', email: 'a@example.com' })).toBeUndefined();
    expect(legacyContactImportRow({ localContactId: 2, companyName: 'Acme', email: ' ' })).toBeUndefined();
  });

  it('builds a deterministic personal import envelope without IO', () => {
    const request = buildLegacyPersonalImport([{ localContactId: 1, companyName: 'Acme', email: 'a@example.com' }], 'checkpoint-1');
    expect(request).toMatchObject({ source: 'legacy-sqlite', kind: 'personal', idempotencyKey: 'legacy-import-checkpoint-1', rows: [{ customerKey: 'legacy-company-1' }] });
  });
});
