import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const appLayout = readFileSync(resolve(root, 'src/renderer/components/layout/AppLayout.tsx'), 'utf8');
const sidebar = readFileSync(resolve(root, 'src/renderer/components/layout/Sidebar.tsx'), 'utf8');
const globalCss = readFileSync(resolve(root, 'src/renderer/global.css'), 'utf8');
const customersCss = readFileSync(resolve(root, 'src/renderer/pages/customers/customers.css'), 'utf8');

describe('page scroll containment', () => {
  it('renders the main workspace as an inset elevated rounded surface', () => {
    expect(appLayout).toContain('className="app-content"');
    expect(appLayout).toContain('className="app-workspace"');
    expect(sidebar).toContain('borderRight: 0');
    expect(globalCss).toMatch(/\.app-workspace\s*\{\s*background:\s*#1a1a1a\s*!important;/s);
    expect(globalCss).toMatch(/\.app-content\s*\{[^}]*margin:\s*3px 6px 6px 0;[^}]*border-radius:\s*12px 8px 8px 12px;[^}]*background:\s*var\(--workspace-canvas\)\s*!important;[^}]*box-shadow:/s);
    expect(globalCss).toMatch(/\.app-titlebar\s*\{[^}]*border-bottom:\s*0;/s);
  });

  it('provides a persisted black workspace preference in settings', () => {
    const settings = readFileSync(resolve(root, 'src/renderer/pages/settings/SettingsPage.tsx'), 'utf8');
    const preferences = readFileSync(resolve(root, 'src/renderer/lib/workspace-preferences.ts'), 'utf8');
    expect(settings).toContain('title="工作区外观"');
    expect(settings).toContain('黑色工作区');
    expect(preferences).toContain("prospector:workspace-dark");
    expect(globalCss).toMatch(/body\.workspace-dark\s*\{[^}]*--workspace-canvas:\s*#0b0d0f;[^}]*--workspace-surface:\s*#15181b;[^}]*--workspace-control:\s*#202328;/s);
  });

  it('keeps the outer workspace fixed and scrolls only the route content', () => {
    expect(appLayout).toContain('overflow: "hidden"');
    expect(appLayout).toContain("overflowY: fullScreen ? 'hidden' : 'auto'");
    expect(globalCss).toMatch(/\.app-route-content\s*\{[^}]*height:\s*100%;[^}]*overflow-x:\s*hidden;/s);
    expect(globalCss).toMatch(/\.app-route-host\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;/s);
  });

  it('fits table and assignment pages to the remaining workspace height', () => {
    expect(globalCss).toMatch(/\.prospector-table-page\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;/s);
    expect(customersCss).toMatch(/\.customer-assignment-page\s*\{[^}]*height:\s*auto;[^}]*min-height:\s*0;/s);
    expect(customersCss).not.toMatch(/\.customer-assignment-page\s*\{[^}]*100vh/s);
  });

  it('lets the contact table grow naturally for route content scrolling', () => {
    expect(customersCss).toMatch(/\.customer-legacy-page\s*>\s*\.customer-contacts-page\s*\{[^}]*flex:\s*0\s+0\s+auto;/s);
    expect(customersCss).toMatch(/\.customer-contacts-page \.customer-contacts-table \.ant-table-content\s*\{[^}]*overflow-y:\s*visible!important;?/s);
  });

  it('keeps an empty assignment table compact and removes header separators', () => {
    expect(customersCss).toMatch(/\.customer-assignment-table\.is-empty[\s\S]*flex:\s*0\s+0\s+auto;/s);
    expect(customersCss).toMatch(/\.customer-assignment-table\.is-empty \.ant-table-thead>tr>th::before\s*\{\s*display:\s*none!important;?/s);
  });

  it('uses one border around the campaign contact picker table', () => {
    expect(globalCss).toMatch(/\.picker-compact \.ant-table-container\s*\{\s*border:\s*0\s*!important;\s*border-radius:\s*0\s*!important;/s);
  });

  it('renders contact details as a themed floating context layer', () => {
    const detail = readFileSync(resolve(root, 'src/renderer/components/ContactDetail.tsx'), 'utf8');
    expect(detail).toContain('rootClassName="customer-contact-detail-layer"');
    expect(customersCss).toMatch(/\.customer-contact-detail-layer \.ant-drawer-content-wrapper,[\s\S]*top:\s*3px\s*!important;[\s\S]*right:\s*6px\s*!important;[\s\S]*bottom:\s*6px\s*!important;/s);
    expect(customersCss).toMatch(/body\.workspace-dark \.customer-contact-detail-layer \.ant-drawer-body\s*\{[^}]*background:\s*var\(--workspace-surface\);/s);
    expect(customersCss).toMatch(/body\.workspace-dark \.customer-contact-detail-layer \.text-gray-900[\s\S]*color:\s*var\(--workspace-text\)\s*!important;/s);
  });

  it('keeps the contact detail mounted long enough to play its exit motion', () => {
    const detail = readFileSync(resolve(root, 'src/renderer/pages/customers/CenterContactDetail.tsx'), 'utf8');
    const assignments = readFileSync(resolve(root, 'src/renderer/pages/customers/ContactAssignments.tsx'), 'utf8');
    expect(detail).toContain('const CONTACT_DETAIL_EXIT_MS = 320');
    expect(detail).toContain('setOpen(false)');
    expect(detail).toContain('setActiveReference(null)');
    expect(assignments).not.toContain("key={selected?.requestId ?? 'closed'}");
  });
});
