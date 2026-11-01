import { describe, expect, it } from 'vitest';
import { CRM_CORE_MOCK_CHAIN } from '../fixtures/crm-core-mock-chain';

describe('CRM core cumulative mock chain', () => {
  it('contains the complete role and organization matrix', () => {
    const roles = new Set(CRM_CORE_MOCK_CHAIN.accounts.flatMap(account => account.roles));
    expect(roles).toEqual(new Set(['admin', 'operations', 'sales', 'auditor']));
    expect(CRM_CORE_MOCK_CHAIN.accounts.filter(account => account.identityAdmin)).toHaveLength(2);
    expect(new Set(CRM_CORE_MOCK_CHAIN.teams.flatMap(team => team.members.map(member => member.account))).size)
      .toBe(CRM_CORE_MOCK_CHAIN.teams.flatMap(team => team.members).length);
    expect(CRM_CORE_MOCK_CHAIN.teams.filter(team => team.leader === 'leader-a')).toHaveLength(2);
    expect(CRM_CORE_MOCK_CHAIN.organization.company.kind).toBe('company');
    expect(CRM_CORE_MOCK_CHAIN.organization.operationsGroups.every(group => group.parent === 'company-root')).toBe(true);
    expect(CRM_CORE_MOCK_CHAIN.teams.every(team => CRM_CORE_MOCK_CHAIN.organization.operationsGroups.some(group => group.key === team.parent))).toBe(true);
  });

  it('covers conflict, mail, assignment, and derived metric acceptance data', () => {
    expect(new Set(CRM_CORE_MOCK_CHAIN.conflicts.map(item => item.expected))).toEqual(new Set([
      'exact_email', 'exact_domain', 'exact_company', 'strong_company',
    ]));
    expect(CRM_CORE_MOCK_CHAIN.mail.map(item => item.relevance)).toEqual(expect.arrayContaining([
      'customer_business', 'internal', 'vendor', 'spam', 'notification',
    ]));
    expect(CRM_CORE_MOCK_CHAIN.mail.some(item => 'humanPrecedence' in item)).toBe(true);
    expect(new Set(CRM_CORE_MOCK_CHAIN.assignments.map(item => item.expected))).toEqual(new Set([
      'pending', 'grouped', 'expired', 'pending_transfer',
    ]));
    expect(CRM_CORE_MOCK_CHAIN.metrics.expected_member_metrics).toContain('claim_to_valid_reply_seconds');
    expect(CRM_CORE_MOCK_CHAIN.attention.map(item => item.reason)).toEqual(expect.arrayContaining([
      'important_reply', 'quote_overdue', 'bounce_correction',
    ]));
    expect(CRM_CORE_MOCK_CHAIN.analysis.some(item => 'humanLocked' in item && item.humanLocked)).toBe(true);
    expect(CRM_CORE_MOCK_CHAIN.analysis.some(item => 'lateAiMustNotOverride' in item && item.lateAiMustNotOverride)).toBe(true);
    expect(CRM_CORE_MOCK_CHAIN.monitoring.forbiddenForSales).toContain('team-overview');
    expect(CRM_CORE_MOCK_CHAIN.performance.strata).toEqual(['source', 'batch', 'country']);
  });
});
