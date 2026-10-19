import type { ContactPermissions, ContactShareGrant } from '../../../shared/online-crm';
/** Renderer affordances mirror authoritative grants; server remains the write authority. */
export function canEditContactField(rights: ContactPermissions, field: string): boolean {
  if (field === 'relationshipStage') return rights.canChangeStage;
  if (field === 'status') return rights.canFollowup;
  return rights.editableFields.includes(field);
}
export function shareGrantWithin(rights: ContactPermissions, grant: ContactShareGrant): ContactShareGrant {
  return { editableFields: grant.editableFields.filter(field => rights.editableFields.includes(field)), canFollowup: rights.canFollowup && grant.canFollowup, canChangeStage: rights.canChangeStage && grant.canChangeStage };
}
