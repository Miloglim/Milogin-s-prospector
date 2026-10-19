import { describe, expect, it } from 'vitest';
import { canSendToContact, canEditContactFields } from '../../src/main/core/contact-permissions';

describe('desktop contact permissions', () => {
  it('allows mail without followup rights and honors explicit denial', () => {
    expect(canSendToContact({ isShared: true, canFollowup: false, canSendMail: true })).toBe(true);
    expect(canSendToContact({ canFollowup: true, canSendMail: false })).toBe(false);
  });
  it('never infers shared send rights from old coarse flags', () => {
    expect(canSendToContact({ isShared: true, canFollowup: true })).toBe(false);
    expect(canSendToContact({ canFollowup: true })).toBe(true);
  });
  it('requires every requested field and does not infer shared grants', () => {
    expect(canEditContactFields({ canEdit: true, permissions: { editableFields: ['phone'] } }, ['phone'])).toBe(true);
    expect(canEditContactFields({ canEdit: true, permissions: { editableFields: ['phone'] } }, ['phone', 'email'])).toBe(false);
    expect(canEditContactFields({ isShared: true, canEdit: true }, ['phone'])).toBe(false);
    expect(canEditContactFields({ canEdit: true }, ['phone'])).toBe(true);
  });
});
