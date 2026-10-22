import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const source = readFileSync(resolve(root, 'src/renderer/pages/contacts/ContactList.tsx'), 'utf8');
const css = readFileSync(resolve(root, 'src/renderer/pages/customers/customers.css'), 'utf8');

describe('contact add drawer presentation', () => {
  it('reuses the contact detail drawer instead of the default narrow Ant drawer', () => {
    expect(source).toContain('<ContactDetailLayout open={addOpen}');
    expect(source).toContain('className="contact-add-header"');
    expect(source).not.toContain('rootClassName="app-drawer-below-titlebar" title="新增联系人"');
  });

  it('keeps field spacing and the save action aligned with contact detail', () => {
    expect(source).toContain('<SectionTitle>公司资料</SectionTitle>');
    expect(source).toContain('className="contact-add-scroll"');
    expect(source).toContain('className="contact-add-footer"');
    expect(css).toContain('.contact-add-form .ant-form-item{margin-bottom:10px}');
    expect(css).toContain('.contact-add-footer{flex-shrink:0;padding-top:10px;border-top:1px solid var(--customer-border)');
  });
});
