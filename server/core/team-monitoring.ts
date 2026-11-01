import type { CrmRole } from './auth';
import type { Result } from './crm';
import type { OrganizationUnitKind } from './organization';
import type { ContactTouchStatus, CustomerStage } from './leads';
import type { MailAnalysisSource, MailBusinessSignal, MailIntentCode, MailPriority, MailRelevance } from './mail-analysis';
import type { MailClassification } from './contact-mail';

export const TEAM_MONITORING_ROUTES = {
  overview: '/api/crm/team-monitoring',
  members: '/api/crm/team-monitoring/members',
  contacts: '/api/crm/team-monitoring/contacts',
  mail: '/api/crm/team-monitoring/mail',
} as const;

export const TEAM_MONITORING_LIMITS = {
  page: 25,
  pageMax: 100,
  unitPage: 25,
  actionPage: 20,
  mailPage: 20,
  text: 500,
} as const;

export type TeamMonitoringScope = 'leader' | 'operations' | 'superadmin';

export function teamMonitoringScopeFor(input: { identityAdmin: boolean; roles: readonly CrmRole[] }): TeamMonitoringScope | null {
  if (input.identityAdmin || input.roles.includes('admin')) return 'superadmin';
  if (input.roles.includes('operations')) return 'operations';
  if (input.roles.includes('sales')) return 'leader';
  return null;
}

export interface TeamMonitoringRates {
  contactRate: number;
  replyRate: number;
  bounceRate: number;
  actionRate: number;
}

export interface TeamMonitoringCounts {
  contacts: number;
  uncontacted: number;
  contacted: number;
  replied: number;
  bounced: number;
  autoreply: number;
  openActions: number;
  overdueActions: number;
  importantReplies: number;
  openAttention: number;
  pendingAssignments: number;
  pendingTransfers: number;
}

export interface TeamMonitoringStageCounts {
  cold: number;
  reaching: number;
  quoting: number;
  trial: number;
  cooperating: number;
  lost: number;
  other: number;
}

export interface TeamMonitoringMemberSummary {
  userId: string;
  displayName: string;
  email: string | null;
  teamId: string;
  teamName: string;
  organizationKind: OrganizationUnitKind;
  counts: TeamMonitoringCounts;
  rates: TeamMonitoringRates;
  stages: TeamMonitoringStageCounts;
  lastActivityAt: string | null;
  latestImportantReplyAt: string | null;
}

export interface TeamMonitoringUnitSummary {
  unitId: string;
  name: string;
  kind: OrganizationUnitKind;
  parentUnitId: string | null;
  memberCount: number;
  counts: TeamMonitoringCounts;
  rates: TeamMonitoringRates;
}

export interface TeamMonitoringAction {
  actionId: string;
  kind: 'task' | 'attention';
  title: string;
  customerId: string;
  customerName: string;
  contactId: number | null;
  contactName: string | null;
  dueAt: string | null;
  occurredAt: string;
  priority: MailPriority;
}

export interface TeamMonitoringMailSummary {
  eventId: string;
  contactId: number;
  customerId: string;
  subject: string;
  kind: string;
  direction: 'inbound' | 'outbound';
  occurredAt: string;
  analysisId: string | null;
  classification: MailClassification | null;
  relevance: MailRelevance | null;
  summary: string | null;
  signals: MailBusinessSignal[];
  intent: MailIntentCode | null;
  requiresAction: boolean;
  nextAction: string | null;
  priority: MailPriority | null;
  confidence: number | null;
  source: MailAnalysisSource | null;
  analyzerVersion: string | null;
}

export interface TeamMonitoringAttentionSummary {
  itemId: string;
  memberUserId: string;
  memberName: string;
  customerId: string;
  customerName: string;
  contactId: number;
  contactName: string;
  reason: string;
  priority: MailPriority;
  status: string;
  note: string | null;
  updatedAt: string;
}

export interface TeamMonitoringPoolSummary {
  unassignedOperationsContacts: number;
  assignedOperationsContacts: number;
  pendingAssignmentRequests: number;
  pendingTransferRequests: number;
}

export interface TeamMonitoringOverview {
  scope: TeamMonitoringScope;
  generatedAt: string;
  units: { items: TeamMonitoringUnitSummary[]; total: number };
  members: { items: TeamMonitoringMemberSummary[]; total: number };
  counts: TeamMonitoringCounts;
  rates: TeamMonitoringRates;
  pool: TeamMonitoringPoolSummary | null;
  importantReplies: TeamMonitoringMailSummary[];
}

export interface TeamMonitoringQuery {
  teamId?: string;
  memberUserId?: string;
  limit: number;
  offset: number;
  unitLimit: number;
  unitOffset: number;
}

export interface TeamMonitoringMemberDetail {
  scope: TeamMonitoringScope;
  generatedAt: string;
  member: TeamMonitoringMemberSummary;
  recentActions: TeamMonitoringAction[];
  attention: TeamMonitoringAttentionSummary[];
  recentMail: TeamMonitoringMailSummary[];
}

export interface TeamMonitoringContactSummary {
  auditId: string;
  scope: TeamMonitoringScope;
  contactId: number;
  customerId: string;
  companyId: number;
  companyName: string;
  name: string;
  email: string | null;
  country: string | null;
  title: string | null;
  stage: CustomerStage;
  touchStatus: ContactTouchStatus;
  ownerUserId: string | null;
  ownerName: string | null;
  origin: 'operations' | 'personal';
  createdAt: string;
  updatedAt: string;
  mail: { items: TeamMonitoringMailSummary[]; total: number };
}

export interface TeamMonitoringMailDetail {
  auditId: string;
  scope: TeamMonitoringScope;
  mail: TeamMonitoringMailSummary;
}

export interface TeamMonitoringRepository {
  overview(tokenHash: string, query: TeamMonitoringQuery): Promise<Result<TeamMonitoringOverview>>;
  member(tokenHash: string, userId: string, limit: number, offset: number): Promise<Result<TeamMonitoringMemberDetail>>;
  contact(tokenHash: string, contactId: number, customerId: string, limit: number, offset: number): Promise<Result<TeamMonitoringContactSummary>>;
  mail(tokenHash: string, eventId: string, contactId: number, customerId: string): Promise<Result<TeamMonitoringMailDetail>>;
}
