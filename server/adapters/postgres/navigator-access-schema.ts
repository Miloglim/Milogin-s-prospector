export const NAVIGATOR_ACCESS_VERSION = "005-navigator-access";
export const NAVIGATOR_PRODUCT_VERSION = "006-navigator-product";
export const NAVIGATOR_ACCESS_SQL = `
ALTER TABLE identity.product_grants DROP CONSTRAINT product_grants_product_id_check;
ALTER TABLE identity.product_grants ADD CONSTRAINT product_grants_product_id_check
 CHECK (product_id IN ('crm','navigator'));
`;
export const NAVIGATOR_PRODUCT_SQL = `
UPDATE identity.products
SET connected = true,
    description = '中心身份、产品准入与运价库账号授权已接入；运价业务仍由 Navigator 服务提供'
WHERE product_id = 'navigator';
`;
