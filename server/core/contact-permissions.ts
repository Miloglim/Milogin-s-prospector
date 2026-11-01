import type {ContactPermissions,ContactShareGrant} from './contact-sharing';
import {CONTACT_SHARED_FIELDS} from './contact-sharing';
export interface ContactPermissionActor {userId:string;roles:readonly string[];scope:string;capabilities:readonly string[];}
export interface ContactPermissionRow {ownerUserId:string|null;origin:string;created_by:string;development_restriction?:string|null;active_assignment_status?:string|null;shared_grant?:ContactShareGrant|null;}
const FULL_FIELDS=['email',...CONTACT_SHARED_FIELDS,'sourceLevel1','sourceLevel2','tags','preferences'];
/** Superadmins may read across the company but do not receive ordinary business-write capability. */
export function globalContactActor(a:ContactPermissionActor):boolean{return a.roles.includes('admin')&&['shared','summary'].includes(a.scope)&&a.capabilities.includes('leads.read.all');}
export function sourceContactManager(a:ContactPermissionActor,r:ContactPermissionRow):boolean{return r.origin==='operations'&&a.roles.includes('operations')&&['shared','summary'].includes(a.scope)&&a.capabilities.includes('leads.assign');}
export function contactPermissions(a:ContactPermissionActor,r:ContactPermissionRow):ContactPermissions {
 const develop=a.capabilities.includes('leads.develop'),transferLocked=r.active_assignment_status==='pending_transfer';
 const manager=sourceContactManager(a,r),full=globalContactActor(a)||manager||r.origin==='personal'&&r.ownerUserId===a.userId;
 const owner=!transferLocked&&r.ownerUserId===a.userId,grant=transferLocked?null:r.shared_grant,allowed=develop&&(full||owner||!!grant);
 const editableFields=(!allowed?[]:full?[...FULL_FIELDS]:owner?[...CONTACT_SHARED_FIELDS,'preferences']:grant?.editableFields.filter(f=>CONTACT_SHARED_FIELDS.includes(f as never))??[]).filter(field=>field!=='clientType'&&field!=='country');
 return {editableFields,canFollowup:allowed&&(full||owner||!!grant?.canFollowup),canChangeStage:allowed&&(full||owner||!!grant?.canChangeStage),canSendMail:allowed&&!r.development_restriction?.trim(),canShare:develop&&owner&&r.origin==='operations'&&r.active_assignment_status==='accepted'&&!r.development_restriction?.trim()};
}
