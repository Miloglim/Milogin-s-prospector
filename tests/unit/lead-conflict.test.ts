import { describe, expect, it } from 'vitest';
import { companyNameSimilarity, matchCompanyConflict, normalizeCompanyDomain, normalizeCompanyName } from '../../server/core/lead-conflict';

describe('lead conflict matching', () => {
  it('normalizes domains and legal company suffixes without erasing meaningful names', () => {
    expect(normalizeCompanyDomain('HTTPS://www.Acme-Logistics.com/path')).toBe('acme-logistics.com');
    expect(normalizeCompanyName('ACME Logistics Co., Ltd.')).toBe('acme');
    expect(normalizeCompanyName('上海远洋贸易有限公司')).toContain('上海远洋');
  });

  it('treats the same domain as a strong conflict and similar names as review candidates', () => {
    const exact = matchCompanyConflict({ companyName: 'Acme Brazil', domain: 'acme.com' }, [{ companyId: 1, name: 'Another Name', domain: 'https://www.acme.com' }]);
    expect(exact).toMatchObject({ companyId: 1, level: 'exact_domain', score: 1 });
    const fuzzy = matchCompanyConflict({ companyName: 'Acme Global Logistics', country: 'Brazil' }, [{ companyId: 2, name: 'Acme Logistics', country: 'Brazil' }]);
    expect(fuzzy?.level).toBe('exact_company');
    expect(companyNameSimilarity('Acme Logistics', 'Acme Shipping')).toBeGreaterThan(0.5);
  });

  it('requires matching countries before an exact company-name conflict', () => {
    const company = { companyId: 3, name: 'Acme Logistics Ltd', country: 'Brazil' };
    expect(matchCompanyConflict({ companyName: 'Acme Logistics', country: 'Brazil' }, [company])).toMatchObject({ level: 'exact_company' });
    expect(matchCompanyConflict({ companyName: 'Acme Logistics', country: 'Germany' }, [company])).toBeNull();
  });
});
