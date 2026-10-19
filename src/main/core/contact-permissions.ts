interface ContactPermissionSnapshot {
  isShared?: boolean;
  canFollowup?: boolean;
  canSendMail?: boolean;
  canEdit?: boolean;
  permissions?: { editableFields: string[]; canSendMail?: boolean };
}
/** Old owned snapshots remain readable; shared rows require explicit grants. */
export function canSendToContact(row: ContactPermissionSnapshot): boolean {
  if (row.permissions?.canSendMail !== undefined) return row.permissions.canSendMail === true;
  if (row.canSendMail !== undefined) return row.canSendMail === true;
  return row.isShared !== true && row.canFollowup === true;
}
export function canEditContactFields(row: ContactPermissionSnapshot, fields: string[]): boolean {
  if (row.permissions) return fields.every(field => row.permissions!.editableFields.includes(field));
  return row.isShared !== true && row.canEdit === true;
}
