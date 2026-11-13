import { describe, it, expect } from 'vitest';
import { autoMapping, importFingerprint, mappedImportRows, prepareImportRequests } from '../../src/renderer/pages/customers/customerImport';
import { importRowIssue } from '../../server/core/leads';
import { IMPORT_REMARK_MAX, fillForwardImportCompanyFields, normalizeImportCustomerType, normalizeImportEmail, unmatchedImportRemark } from '../../server/core/lead-import-fields';

describe('customer import preparation', () => {
  it('does not silently choose between ambiguous aliases and trims header whitespace', () => {
    expect(autoMapping([' 公司名称 ', '邮箱', '来源客户编号']).companyName).toBe(' 公司名称 ');
    expect(autoMapping(['公司', '公司名称', '邮箱']).companyName).toBe('');
  });
  it('normalizes mapped values while preserving original evidence and optional columns', () => {
    const raw = { id: ' A ', company: ' Test ', email: ' TEST@example.invalid ' };
    expect(mappedImportRows({ headers: Object.keys(raw), rows: [raw], fileName: 'a.csv' }, { customerKey: 'id', companyName: 'company', email: 'email' })).toEqual([{ customerKey: 'A', companyName: 'Test', email: 'test@example.invalid', name: '', country: '', rawRow: raw }]);
  });
  it('uses the first valid address from wrapped or multi-email cells and retains distinct alternatives', () => {
    expect(normalizeImportEmail('Primary <FIRST@example.invalid>; SECOND@example.invalid')).toEqual({ email: 'first@example.invalid', extras: ['second@example.invalid'] });
    expect(normalizeImportEmail('same@example.invalid<same@example.invalid>')).toEqual({ email: 'same@example.invalid', extras: [] });
    expect(normalizeImportEmail('not-an-email')).toEqual({ email: 'not-an-email', extras: [] });
    const raw = { company: 'Test', email: 'A@example.invalid<label>B@example.invalid' };
    expect(mappedImportRows({ headers: Object.keys(raw), rows: [raw], fileName: 'a.csv' }, { companyName: 'company', email: 'email' })[0]?.email).toBe('a@example.invalid');
  });
  it('fills grouped company fields only until the next explicit company and normalizes type synonyms', () => {
    const rows = [
      { company: 'A', country: 'US', type: '货代' },
      { company: '', country: '', type: '' },
      { company: 'B', country: '', type: '直客/基础设施' },
    ];
    expect(fillForwardImportCompanyFields(rows, { companyName: 'company', country: 'country', customerType: 'type' })).toEqual([
      { company: 'A', country: 'US', type: '货代' },
      { company: 'A', country: 'US', type: '货代' },
      { company: 'B', country: '', type: '直客/基础设施' },
    ]);
    expect(normalizeImportCustomerType('货代')).toBe('代理');
    expect(normalizeImportCustomerType('直客/基础设施')).toBe('直客');
  });
  it('matches row validation for missing, invalid and oversized values', () => {
    const row = { customerKey: 'A', companyName: 'Test', email: 'test@example.invalid' };
    expect(importRowIssue(row)).toBeUndefined();
    for (const bad of [{ ...row, email: 'bad' }, { ...row, companyName: '' }, { ...row, customerKey: 'a'.repeat(129) }, { ...row, name: 'a'.repeat(501) }]) expect(importRowIssue(bad)).toBeTruthy();
  });
  it('splits by row count and actual UTF-8 request size and rejects oversized single rows', () => {
    const base = { source: 'test', sourceDetail: '', kind: 'operations' as const };
    const row = { customerKey: 'A', companyName: 'Test', email: 'test@example.invalid' };
    const many = prepareImportRequests(base, Array.from({ length: 201 }, () => row));
    expect(many.ok && many.data.map(batch => batch.payload.rows.length)).toEqual([200, 1]);
    const large = { ...row, rawRow: { note: '中'.repeat(100000) } };
    const bytes = prepareImportRequests(base, [large, large, large, large]);
    expect(bytes.ok && bytes.data.map(batch => batch.payload.rows.length)).toEqual([3, 1]);
    expect(prepareImportRequests(base, [{ ...large, rawRow: { note: '中'.repeat(400000) } }]).ok).toBe(false);
  });
  it('changes the retry fingerprint when the source bytes or field mapping changes', () => {
    const input = { type: 'csv' as const, data: 'id,company\n1,Acme' };
    expect(importFingerprint(input, { customerKey: 'id' })).toBe(importFingerprint(input, { customerKey: 'id' }));
    expect(importFingerprint(input, { customerKey: 'id' })).not.toBe(importFingerprint({ ...input, data: 'id,company\n2,Acme' }, { customerKey: 'id' }));
    expect(importFingerprint(input, { customerKey: 'id' })).not.toBe(importFingerprint(input, { customerKey: 'company' }));
  });
  it('turns every non-empty unmapped column into one labelled remark line', () => {
    const raw = { '公司名称': 'Acme', Phone: '+1 555', '加入协会': 'WCA', Profile: 'line one\nline two', Fax: '(N/A)', '邮箱有效性': '有效', Count: 0 };
    expect(unmatchedImportRemark(raw, ['公司名称', 'phone'])).toBe('加入协会：WCA\nProfile：line one\nline two\n邮箱有效性：有效\nCount：0');
    expect(unmatchedImportRemark({ 公司名称: 'Acme', 备注: '第一行\n第二行' }, ['公司名称'])).toBe('第一行\n第二行');
    expect(unmatchedImportRemark(undefined, [])).toBe('');
    expect(importRowIssue({ customerKey: 'a', companyName: 'Acme', email: 'a@example.invalid', remark: 'x'.repeat(IMPORT_REMARK_MAX + 1) })).toBe('未匹配字段备注过长');
  });
});
