export const CONTACT_ASSIGNMENT_STATUSES = [
  'pending',
  'accepted',
  'rejected',
  'cancelled',
  'expired',
  'pending_transfer',
] as const;

export type ContactAssignmentLifecycleStatus = typeof CONTACT_ASSIGNMENT_STATUSES[number];
export type ContactAssignmentStatus = Exclude<ContactAssignmentLifecycleStatus, 'expired' | 'pending_transfer'>;
export type ContactAssignmentDecisionAction = 'accept' | 'reject' | 'cancel';

export const CONTACT_ASSIGNMENT_ACTIVE_STATUSES = [
  'pending',
  'accepted',
  'pending_transfer',
] as const;

export const CONTACT_ASSIGNMENT_EXPIRY_SECONDS = 7 * 24 * 60 * 60;
export const CONTACT_ASSIGNMENT_EXPIRY_BATCH = 200;

export interface ContactAssignmentCancellationInput {
  status: ContactAssignmentLifecycleStatus;
  actorIsRequester: boolean;
  manager: boolean;
}

export interface ContactAssignmentTransferInput {
  status: ContactAssignmentLifecycleStatus;
  actorIsCurrentOwner: boolean;
  manager: boolean;
  targetUserId: string;
  currentOwnerUserId: string | null;
}

export function canAcceptContactAssignment(status: ContactAssignmentLifecycleStatus): boolean {
  return status === 'pending' || status === 'pending_transfer';
}

export function canRejectContactAssignment(status: ContactAssignmentLifecycleStatus): boolean {
  return status === 'pending';
}

export function canCancelContactAssignment(input: ContactAssignmentCancellationInput): boolean {
  if (input.status !== 'pending' && input.status !== 'pending_transfer') return false;
  return input.manager || input.actorIsRequester;
}

export function canTransferContactAssignment(input: ContactAssignmentTransferInput): boolean {
  if (input.status !== 'accepted' || !input.currentOwnerUserId) return false;
  if (!input.actorIsCurrentOwner && !input.manager) return false;
  return input.targetUserId !== input.currentOwnerUserId;
}

export function contactAssignmentRecipients(
  targetUserId: string,
  supervisorUserIds: readonly string[],
): string[] {
  return [...new Set([targetUserId, ...supervisorUserIds])].sort();
}

export function contactAssignmentSupervisorsFor(
  targetIsMember: boolean,
  directLeaderUserIds: readonly string[],
  targetUserId: string,
): string[] {
  if (!targetIsMember) return [];
  return [...new Set(directLeaderUserIds.filter(userId => userId !== targetUserId))].sort();
}
