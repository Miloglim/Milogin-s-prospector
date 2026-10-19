import { describe, it, expect } from 'vitest';
import { autoMapping } from '../../src/renderer/pages/customers/customerImport';
describe('customer import headers', () => {
  it('maps existing CSV/XLSX headers without an intermediate import file', () => {
    expect(autoMapping(['来源客户编号', '公司名称', '邮箱', '联系人', '国家'])).toEqual({ customerKey: '来源客户编号', companyName: '公司名称', email: '邮箱', name: '联系人', country: '国家' });
    expect(autoMapping(['Customer_Key', 'Company Name', 'E-mail'])).toMatchObject({ customerKey: 'Customer_Key', companyName: 'Company Name', email: 'E-mail' });
  });
});
