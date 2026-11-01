export const CRM_CORE_MOCK_CHAIN = {
  version: 'crm-core-mock-v1',
  accounts: [
    { key: 'super-a', email: 'super-a@mock.invalid', name: 'Super A', identityAdmin: true, roles: ['admin'] },
    { key: 'super-b', email: 'super-b@mock.invalid', name: 'Super B', identityAdmin: true, roles: ['admin'] },
    { key: 'ops-a', email: 'ops-a@mock.invalid', name: 'Operations A', identityAdmin: false, roles: ['operations'] },
    { key: 'ops-b', email: 'ops-b@mock.invalid', name: 'Operations B', identityAdmin: false, roles: ['operations'] },
    { key: 'leader-a', email: 'leader-a@mock.invalid', name: 'Leader A', identityAdmin: false, roles: ['sales'] },
    { key: 'leader-b', email: 'leader-b@mock.invalid', name: 'Leader B', identityAdmin: false, roles: ['sales'] },
    { key: 'sales-a1', email: 'sales-a1@mock.invalid', name: 'Sales A1', identityAdmin: false, roles: ['sales'] },
    { key: 'sales-a2', email: 'sales-a2@mock.invalid', name: 'Sales A2', identityAdmin: false, roles: ['sales'] },
    { key: 'sales-b1', email: 'sales-b1@mock.invalid', name: 'Sales B1', identityAdmin: false, roles: ['sales'] },
    { key: 'sales-b2', email: 'sales-b2@mock.invalid', name: 'Sales B2', identityAdmin: false, roles: ['sales'] },
    { key: 'sales-outside', email: 'sales-outside@mock.invalid', name: 'Outside Sales', identityAdmin: false, roles: ['sales'] },
    { key: 'auditor', email: 'auditor@mock.invalid', name: 'Auditor', identityAdmin: false, roles: ['auditor'] },
  ],
  organization: {
    company: { key: 'company-root', name: 'Milogin Mock Company', kind: 'company', parent: null },
    operationsGroups: [
      { key: 'ops-east', name: 'East Operations', kind: 'operations_group', parent: 'company-root', primaryManager: 'ops-a', managers: ['ops-b'] },
      { key: 'ops-west', name: 'West Operations', kind: 'operations_group', parent: 'company-root', primaryManager: 'ops-b', managers: [] },
    ],
  },
  teams: [
    {
      key: 'team-alpha', name: 'Atlas Team', unitType: 'sales_team', leader: 'leader-a', parent: 'ops-east',
      members: [
        { account: 'sales-a1', group: 'Key Accounts' },
        { account: 'sales-a2', group: 'New Business' },
      ],
    },
    {
      key: 'team-beta', name: 'Beacon Team', unitType: 'sales_team', leader: 'leader-a', parent: 'ops-east',
      members: [{ account: 'sales-b1', group: 'Export' }],
    },
    {
      key: 'team-gamma', name: 'Coast Team', unitType: 'sales_team', leader: 'leader-b', parent: 'ops-west',
      members: [
        { account: 'sales-b2', group: 'Import' },
        { account: 'sales-outside', group: 'Overflow' },
      ],
    },
  ],
  contacts: [
    { key: 'ops-shared', origin: 'operations', owner: 'sales-a1', company: 'Northwind Logistics', domain: 'northwind.example', email: 'buyer@northwind.example', touchStatus: 'uncontacted', stage: 'cold' },
    { key: 'ops-quoted', origin: 'operations', owner: 'sales-a1', company: 'Orchid Freight', domain: 'orchid.example', email: 'ops@orchid.example', touchStatus: 'replied', stage: 'quoting' },
    { key: 'personal-bounce', origin: 'personal', owner: 'sales-b1', company: 'Bounce Trading', domain: 'bounce.example', email: 'gone@bounce.example', touchStatus: 'bounced', stage: 'reaching' },
    { key: 'personal-auto', origin: 'personal', owner: 'sales-b2', company: 'Auto Reply Co', domain: 'auto.example', email: 'hello@auto.example', touchStatus: 'autoreply', stage: 'reaching' },
    { key: 'private-a1', origin: 'personal', owner: 'sales-a1', company: 'Private A1', domain: 'private-a1.example', email: 'owner@private-a1.example', touchStatus: 'contacted', stage: 'trial' },
    { key: 'private-a2', origin: 'personal', owner: 'sales-a2', company: 'Private A2', domain: 'private-a2.example', email: 'owner@private-a2.example', touchStatus: 'contacted', stage: 'reaching' },
    { key: 'recoverable', origin: 'operations', owner: null, company: 'Recovery Logistics', domain: 'recovery.example', email: 'deleted@recovery.example', touchStatus: 'uncontacted', stage: 'cold', softDeleted: true },
  ],
  conflicts: [
    { key: 'same-email', existing: 'ops-shared', company: 'Northwind Logistics', domain: 'northwind.example', email: 'buyer@northwind.example', expected: 'exact_email' },
    { key: 'same-domain', existing: 'ops-shared', company: 'Northwind Global', domain: 'www.northwind.example', email: 'contact@northwind.example', expected: 'exact_domain' },
    { key: 'same-company', existing: 'ops-quoted', company: 'Orchid Freight', domain: 'orchid-new.example', email: 'new@orchid-new.example', expected: 'exact_company' },
    { key: 'similar-company', existing: 'ops-quoted', company: 'Orchid Freight Intl', domain: 'orchid-intl.example', email: 'new@orchid-intl.example', expected: 'strong_company' },
  ],
  mail: [
    { key: 'quote-request', contact: 'ops-shared', classification: 'replied', relevance: 'customer_business', intent: 'quote_request', requiresAction: true, expectedTask: true },
    { key: 'plain-reply', contact: 'private-a1', classification: 'replied', relevance: 'customer_business', intent: 'no_action', requiresAction: false, expectedTask: false },
    { key: 'bounce', contact: 'personal-bounce', classification: 'bounced', relevance: 'notification', intent: 'no_action', requiresAction: false, expectedTask: false },
    { key: 'autoreply', contact: 'personal-auto', classification: 'autoreply', relevance: 'notification', intent: 'no_action', requiresAction: false, expectedTask: false },
    { key: 'internal', contact: 'ops-shared', classification: 'unrelated', relevance: 'internal', intent: 'no_action', requiresAction: false, expectedTask: false },
    { key: 'vendor', contact: 'ops-shared', classification: 'unrelated', relevance: 'vendor', intent: 'no_action', requiresAction: false, expectedTask: false },
    { key: 'spam', contact: 'ops-shared', classification: 'unrelated', relevance: 'spam', intent: 'no_action', requiresAction: false, expectedTask: false },
    { key: 'late-ai', contact: 'ops-quoted', classification: 'replied', relevance: 'customer_business', intent: 'quote_request', requiresAction: true, expectedTask: true, humanPrecedence: 'suppressed' },
  ],
  assignments: [
    { key: 'member-pending', contacts: ['ops-shared'], target: 'sales-a1', expected: 'pending', supervisor: 'leader-a' },
    { key: 'leader-pending', contacts: ['ops-quoted'], target: 'leader-b', expected: 'pending', supervisor: null },
    { key: 'same-group-batch', contacts: ['private-a1', 'private-a2'], target: 'sales-a2', expected: 'grouped', supervisor: 'leader-a' },
    { key: 'expiry', contacts: ['ops-quoted'], target: 'sales-b1', expected: 'expired', supervisor: 'leader-a' },
    { key: 'transfer', contacts: ['ops-quoted'], target: 'sales-b2', expected: 'pending_transfer', supervisor: 'leader-b' },
  ],
  attention: [
    { key: 'important-reply', member: 'sales-a1', supervisor: 'leader-a', contact: 'ops-quoted', reason: 'important_reply', priority: 'important', status: 'open' },
    { key: 'quote-overdue', member: 'sales-b1', supervisor: 'leader-a', contact: 'ops-shared', reason: 'quote_overdue', priority: 'urgent', status: 'acknowledged' },
    { key: 'bounce-fix', member: 'sales-b1', supervisor: 'leader-a', contact: 'personal-bounce', reason: 'bounce_correction', priority: 'normal', status: 'resolved' },
  ],
  analysis: [
    { key: 'human-lock', contact: 'ops-quoted', source: 'human', classification: 'replied', relevance: 'customer_business', requiresAction: true, humanLocked: true, lateAiMustNotOverride: true },
    { key: 'rule-request', contact: 'ops-shared', source: 'rule', classification: 'replied', relevance: 'customer_business', requiresAction: true, humanLocked: false },
    { key: 'late-ai', contact: 'ops-quoted', source: 'ai', classification: 'replied', relevance: 'customer_business', requiresAction: true, humanLocked: false, olderThanCurrent: true },
    { key: 'spam-neutral', contact: 'ops-shared', source: 'rule', classification: 'unrelated', relevance: 'spam', requiresAction: false, humanLocked: false },
  ],
  monitoring: {
    leaderScope: ['sales-a1', 'sales-a2', 'sales-b1'],
    operationsScope: ['ops-shared', 'ops-quoted', 'personal-bounce', 'personal-auto'],
    forbiddenForSales: ['team-overview', 'member-summary', 'contact-summary', 'mail-summary'],
    auditedDrilldowns: ['contact-summary', 'mail-summary'],
  },
  performance: {
    minimumSample: 5,
    strata: ['source', 'batch', 'country'],
    metricKeys: ['claim_to_first_action_seconds', 'claim_to_valid_reply_seconds', 'claim_to_won_seconds', 'repeat_purchase_count', 'repeat_purchase_rate'],
    sampleShortMember: 'sales-b2',
    gradeRules: { A: ['won', 'valid_replies>=3'], B: ['valid_replies>=1', 'open_opportunity'], C: ['otherwise'] },
    manualOverrideAudit: ['reason', 'actor', 'created_at', 'version'],
  },
  metrics: {
    minimum_sample_size: 5,
    expected_member_metrics: ['claim_to_first_action_seconds', 'claim_to_valid_reply_seconds', 'claim_to_won_seconds', 'repeat_purchase_count', 'repeat_purchase_rate'],
    grade_thresholds: { a: { minimumWon: 5, minimumReplyRate: 0.35 }, b: { minimumWon: 2, minimumReplyRate: 0.15 }, c: { minimumWon: 0 } },
  },
} as const;

export type CrmCoreMockChain = typeof CRM_CORE_MOCK_CHAIN;
