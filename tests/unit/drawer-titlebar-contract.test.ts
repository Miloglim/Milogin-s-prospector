import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/renderer/global.css'), 'utf8');

describe('titlebar-safe drawer contract', () => {
  it('keeps drawer content and mask below the application title bar', () => {
    expect(css).toMatch(/\.app-drawer-below-titlebar\s+\.ant-drawer-content-wrapper\s*\{[^}]*top:\s*var\(--app-titlebar-height\)/s);
    expect(css).toMatch(/\.app-drawer-below-titlebar\s+\.ant-drawer-content-wrapper\s*\{[^}]*height:\s*calc\(100%\s*-\s*var\(--app-titlebar-height\)\)/s);
    expect(css).toMatch(/\.app-drawer-below-titlebar\s+\.ant-drawer-mask\s*\{[^}]*top:\s*var\(--app-titlebar-height\)/s);
  });

  it('marks the import drawer as titlebar-safe', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/renderer/components/ImportDrawer.tsx'), 'utf8');
    expect(source).toContain('app-drawer-below-titlebar');
  });

  it('keeps import preview fields on one line with fixed table columns', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/renderer/components/ImportDrawer.tsx'), 'utf8');
    expect(source).toContain('tableLayout="fixed"');
    expect(source).toContain('ellipsis: true');
    expect(source).toContain('contact-import-preview-table');
    expect(css).toMatch(/\.contact-import-preview-table\s+\.ant-table-cell\s*\{[^}]*white-space:\s*nowrap;[^}]*text-overflow:\s*ellipsis;/s);
  });
});
