import { CONTACT_TOUCH_STATUSES } from '../../core/leads';

export const CONTACT_TOUCH_STATUS_VERSION = '031-contact-touch-outcomes';
const statuses = CONTACT_TOUCH_STATUSES.map(value => `'${value}'`).join(',');

/** Upgrade the legacy reached/replied enum without discarding mail-derived outcomes. */
export const CONTACT_TOUCH_STATUS_SQL = `
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_crm_touch_status_check;
UPDATE contacts SET crm_touch_status=CASE
 WHEN status='replied' THEN 'replied'
 WHEN status='bounced' THEN 'bounced'
 WHEN status='autoreply' THEN 'autoreply'
 WHEN status='reached' AND crm_touch_status='uncontacted' THEN 'contacted'
 WHEN crm_touch_status='unreachable' THEN 'uncontacted'
 ELSE crm_touch_status END;
ALTER TABLE contacts ADD CONSTRAINT contacts_crm_touch_status_check CHECK(crm_touch_status IN (${statuses}));
ALTER TABLE crm_shared_activities DROP CONSTRAINT IF EXISTS crm_shared_activities_contact_status_check;
UPDATE crm_shared_activities SET contact_status='uncontacted' WHERE contact_status='unreachable';
ALTER TABLE crm_shared_activities ADD CONSTRAINT crm_shared_activities_contact_status_check CHECK(contact_status IS NULL OR contact_status IN (${statuses}));
`;
