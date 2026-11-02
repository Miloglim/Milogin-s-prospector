import { describe, expect, it } from 'vitest';
import { productEdition, productEditionAllowsPath } from '../../src/renderer/lib/product-edition';

describe('contact auto-development edition', () => {
  it('defaults to the full product and accepts only the explicit focused identifier', () => {
    expect(productEdition(undefined)).toBe('full');
    expect(productEdition('full')).toBe('full');
    expect(productEdition('contact-autodev')).toBe('contact-autodev');
  });

  it('allows only contacts, auto-development and required support routes in the focused edition', () => {
    for (const path of ['/customers', '/assistant', '/campaigns', '/settings', '/account']) expect(productEditionAllowsPath('contact-autodev', path)).toBe(true);
    for (const path of ['/inbox', '/team', '/rates', '/templates', '/messages', '/']) expect(productEditionAllowsPath('contact-autodev', path)).toBe(false);
    expect(productEditionAllowsPath('full', '/inbox')).toBe(true);
  });
});
