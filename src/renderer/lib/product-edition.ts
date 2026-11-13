export type ProductEdition = 'full' | 'contact-autodev';

const CONTACT_AUTODEV_PATHS = new Set(['/customers', '/campaigns', '/templates', '/settings', '/account']);

export function productEdition(value: string | undefined): ProductEdition {
  return value === 'contact-autodev' ? 'contact-autodev' : 'full';
}

export function productEditionAllowsPath(edition: ProductEdition, pathname: string): boolean {
  return edition === 'full' || CONTACT_AUTODEV_PATHS.has(pathname);
}

export function productEditionOfflineEntryPath(edition: ProductEdition): '/customers' | '/inbox' {
  return edition === 'contact-autodev' ? '/customers' : '/inbox';
}

export const PRODUCT_EDITION = productEdition(import.meta.env.VITE_PROSPECTOR_EDITION);
export const CONTACT_AUTODEV_EDITION = PRODUCT_EDITION === 'contact-autodev';
