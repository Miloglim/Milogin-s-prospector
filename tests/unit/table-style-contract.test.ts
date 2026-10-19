import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const globalCss = readFileSync(resolve(process.cwd(), 'src/renderer/global.css'), 'utf8');

describe('shared table visual contract', () => {
  it('defines the compact customer-contact table metrics for every Ant Design table', () => {
    expect(globalCss).toMatch(/\.ant-table-tbody\s*>\s*tr\s*>\s*td\s*\{[^}]*height:\s*42px/s);
    expect(globalCss).toMatch(/\.ant-table-tbody\s*>\s*tr\s*>\s*td\s*\{[^}]*padding:\s*4px\s+10px/s);
    expect(globalCss).toMatch(/\.ant-table-thead\s*>\s*tr\s*>\s*th\s*\{[^}]*font-size:\s*11px/s);
  });

  it('keeps an adaptive border and a stable empty-state area when there are no rows', () => {
    expect(globalCss).toMatch(/\.ant-table-container\s*\{[^}]*border:\s*1px\s+solid/s);
    expect(globalCss).toMatch(/\.ant-table-placeholder\s*>\s*td\s*\{[^}]*padding:\s*24px\s+10px/s);
    expect(globalCss).toMatch(/\.ant-table-placeholder\s*>\s*td\s*\{[^}]*min-height:\s*96px/s);
  });
});
