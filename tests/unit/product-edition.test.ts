import { describe, expect, it } from 'vitest';
import { productEdition, productEditionAllowsPath, productEditionOfflineEntryPath } from '../../src/renderer/lib/product-edition';

describe('contact auto-development edition', () => {
  it('defaults to the full product and accepts only the explicit focused identifier', () => {
    expect(productEdition(undefined)).toBe('full');
    expect(productEdition('full')).toBe('full');
    expect(productEdition('contact-autodev')).toBe('contact-autodev');
  });

  it('allows only contacts, auto-development and required support routes in the focused edition', () => {
    for (const path of ['/customers', '/campaigns', '/templates', '/settings', '/account']) expect(productEditionAllowsPath('contact-autodev', path)).toBe(true);
    for (const path of ['/inbox', '/team', '/rates', '/assistant', '/messages', '/']) expect(productEditionAllowsPath('contact-autodev', path)).toBe(false);
    expect(productEditionAllowsPath('full', '/inbox')).toBe(true);
  });

  it('opens a route that the edition actually allows when starting offline', () => {
    expect(productEditionOfflineEntryPath('full')).toBe('/inbox');
    expect(productEditionOfflineEntryPath('contact-autodev')).toBe('/customers');
  });
});
