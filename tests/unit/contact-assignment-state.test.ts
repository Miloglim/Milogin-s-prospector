import { describe, expect, it } from 'vitest';
import {
  CONTACT_ASSIGNMENT_STATUSES,
  canAcceptContactAssignment,
  canCancelContactAssignment,
  canRejectContactAssignment,
  canTransferContactAssignment,
  contactAssignmentRecipients,
  contactAssignmentSupervisorsFor,
} from '../../server/core/contact-assignment-state';
import {contactPermissions} from '../../server/core/contact-permissions';

describe('contact assignment state', () => {
  it('keeps initial decisions and transfer decisions distinct', () => {
    expect(canAcceptContactAssignment('pending')).toBe(true);
    expect(canAcceptContactAssignment('pending_transfer')).toBe(true);
    expect(canAcceptContactAssignment('accepted')).toBe(false);
    expect(canRejectContactAssignment('pending')).toBe(true);
    expect(canCancelContactAssignment({ status: 'pending', actorIsRequester: false, manager: true })).toBe(true);
    expect(canCancelContactAssignment({ status: 'pending_transfer', actorIsRequester: true, manager: false })).toBe(true);
    expect(canCancelContactAssignment({ status: 'expired', actorIsRequester: true, manager: true })).toBe(false);
  });

  it('publishes the complete lifecycle status set', () => {
    expect(CONTACT_ASSIGNMENT_STATUSES).toEqual([
      'pending',
      'accepted',
      'rejected',
      'cancelled',
      'expired',
      'pending_transfer',
    ]);
  });

  it('locks the old owner during transfer while retaining operations governance and global superadmin contact access', () => {
    const row = {ownerUserId:'owner',created_by:'ops',origin:'operations',active_assignment_status:'pending_transfer'};
    expect(contactPermissions({userId:'owner',roles:['sales'],scope:'own',capabilities:['leads.develop']},row)).toEqual({
      editableFields:[],canFollowup:false,canChangeStage:false,canSendMail:false,canShare:false,
    });
    expect(contactPermissions({userId:'ops',roles:['operations'],scope:'shared',capabilities:['leads.develop','leads.assign']},row)).toMatchObject({
      canFollowup:true,canChangeStage:true,canSendMail:true,
    });
    expect(contactPermissions({userId:'superadmin',roles:['admin'],scope:'summary',capabilities:['leads.develop','leads.read.all']},row).editableFields).toContain('email');
  });

  it('allows transfers only from an accepted current owner or a manager', () => {
    const common = { status: 'accepted' as const, targetUserId: 'new-owner', currentOwnerUserId: 'old-owner' };
    expect(canTransferContactAssignment({ ...common, actorIsCurrentOwner: true, manager: false })).toBe(true);
    expect(canTransferContactAssignment({ ...common, actorIsCurrentOwner: false, manager: true })).toBe(true);
    expect(canTransferContactAssignment({ ...common, actorIsCurrentOwner: false, manager: false })).toBe(false);
    expect(canTransferContactAssignment({ ...common, actorIsCurrentOwner: true, targetUserId: 'old-owner' })).toBe(false);
    expect(canTransferContactAssignment({ ...common, status: 'pending_transfer', actorIsCurrentOwner: true })).toBe(false);
  });

  it('derives recipients without sharing a leader target to team members', () => {
    expect(contactAssignmentSupervisorsFor(true, ['leader-a', 'leader-a', 'member'], 'member')).toEqual(['leader-a']);
    expect(contactAssignmentSupervisorsFor(false, ['leader-a'], 'leader-a')).toEqual([]);
    expect(contactAssignmentRecipients('member', ['leader-a', 'member'])).toEqual(['leader-a', 'member']);
  });
});
