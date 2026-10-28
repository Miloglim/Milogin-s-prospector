export const NAVIGATOR_ACCESS_VERSION = "005-navigator-access-public";
export const NAVIGATOR_PRODUCT_VERSION = "006-navigator-product-public";
export const NAVIGATOR_ACCESS_SQL = `
ALTER TABLE public.identity_product_grants DROP CONSTRAINT IF EXISTS identity_product_grants_product_id_check;
ALTER TABLE public.identity_product_grants ADD CONSTRAINT identity_product_grants_product_id_check
 CHECK (product_id IN ('crm','navigator'));
`;
export const NAVIGATOR_PRODUCT_SQL = `
UPDATE public.identity_products
SET connected = true,
    description = '中心身份、产品准入与运价库账号授权已接入；运价业务仍由 Navigator 服务提供'
WHERE product_id = 'navigator';
`;
