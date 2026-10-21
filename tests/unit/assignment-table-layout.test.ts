import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/renderer/pages/customers/customers.css'), 'utf8');
const source = readFileSync(resolve(process.cwd(), 'src/renderer/pages/customers/ContactAssignments.tsx'), 'utf8');

describe('assignment table layout', () => {
  it('uses the remaining workspace height and a flexible table region', () => {
    expect(css).toMatch(/\.customer-assignment-page\{[^}]*flex:1 1 auto;[^}]*height:auto;[^}]*min-height:0/s);
    expect(css).toMatch(/\.customer-assignment-table\{[^}]*flex:1/s);
    expect(css).toMatch(/\.customer-assignment-table \.ant-table-body\{[^}]*flex:1/s);
  });

  it('marks assignment tables for the shared full-height layout', () => {
    expect(source).toContain('customer-assignment-page');
    expect(source).toContain('customer-assignment-table');
  });
});
