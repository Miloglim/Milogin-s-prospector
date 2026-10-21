import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');

describe('full-height table page contract', () => {
  it('defines a shared flex layout that consumes the remaining workspace height', () => {
    const css = readFileSync(resolve(root, 'src/renderer/global.css'), 'utf8');
    expect(css).toContain('.prospector-table-page');
    const pageRule = css.match(/\.prospector-table-page \{[^}]+\}/s)?.[0] ?? '';
    expect(pageRule).toContain('height: 100%');
    expect(pageRule).toContain('min-height: 0');
    expect(css).toContain('.prospector-page-table .ant-table-body');
    expect(css).toContain('.prospector-page-table .ant-table-content');
    expect(css).toContain('overflow: auto !important');
    expect(css).toContain('.prospector-page-table .ant-table-content::-webkit-scrollbar-thumb');
    expect(css).toContain('background: transparent');
    expect(css).toContain('is-scrolling-x');
    expect(css).toContain('is-scrolling-y');
    expect(css).not.toContain('scrollbar-color: #c9cdd2');
    expect(css).toContain('.prospector-page-table .ant-table-cell-fix-right');
    const innerTableRule = css.match(/\.prospector-page-table \.ant-table \{[^}]+\}/s)?.[0] ?? '';
    expect(innerTableRule).not.toContain('display: flex');
  });

  it('marks the primary data table pages instead of card tables', () => {
    const files = [
      'src/renderer/pages/contacts/ContactList.tsx',
      'src/renderer/pages/rates/RateBoard.tsx',
      'src/renderer/pages/customers/CustomerLegacyShell.tsx',
      'src/renderer/pages/customers/ContactAssignments.tsx',
      'src/renderer/pages/history/HistoryPage.tsx',
      'src/renderer/pages/templates/TemplateList.tsx',
    ];
    for (const file of files) {
      const source = readFileSync(resolve(root, file), 'utf8');
      expect(source).toContain('prospector-page-table');
    }
  });
});
