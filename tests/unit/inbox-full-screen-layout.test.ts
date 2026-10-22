import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const appLayout = readFileSync(resolve(root, 'src/renderer/components/layout/AppLayout.tsx'), 'utf8');
const inbox = readFileSync(resolve(root, 'src/renderer/pages/inbox/InboxList.tsx'), 'utf8');
const css = readFileSync(resolve(root, 'src/renderer/global.css'), 'utf8');

describe('inbox full-screen layout', () => {
  it('keeps the inbox edge-to-edge while giving its panes internal scrolling', () => {
    expect(appLayout).toContain("const EDGE_TO_EDGE_PATHS = new Set(['/inbox'])") ;
    expect(appLayout).toContain('app-scroll-area--edge-to-edge');
    expect(appLayout).toContain('app-route-content--edge-to-edge');
    expect(appLayout).toContain("padding: fullScreen ? 0 : '16px 20px'");
    expect(css).toMatch(/\.app-scroll-area--edge-to-edge\s*\{[^}]*padding:\s*0;/s);
    expect(css).toMatch(/\.app-scroll-area--edge-to-edge\s*\{[^}]*overflow:\s*hidden;/s);
    expect(css).toMatch(/\.app-route-content--edge-to-edge\s*\{[^}]*height:\s*100%;/s);
  });

  it('keeps the mail list readable while giving the reading pane the remaining width', () => {
    expect(inbox).toContain('const ROW_H = 66');
    expect(inbox).toContain('width: "38%"');
    expect(inbox).toContain('minWidth: 400');
    expect(inbox).toContain('maxWidth: 680');
    expect(inbox).not.toContain('width: "34%"');
  });

  it('uses the full available height while keeping each pane internally scrollable', () => {
    expect(inbox).toContain('className="inbox-workspace prospector-inbox-page flex h-full"');
    expect(inbox).not.toContain('calc(100vh - 130px)');
    expect(css).toMatch(/\.inbox-workspace\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*min-height:\s*0;/s);
  });

  it('keeps the detail header and metadata on the same themed layout system', () => {
    expect(inbox).toContain('function InboxDetailRow');
    expect(inbox).toContain('className="inbox-detail-header selectable"');
    expect(inbox).toContain('className="inbox-detail-meta-grid"');
    expect(css).toMatch(/\.inbox-detail-header\s*\{[^}]*background:\s*var\(--workspace-surface\);/s);
    expect(css).toMatch(/\.inbox-detail-meta-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/s);
  });

  it('keeps the right detail rows compact without shrinking content width', () => {
    expect(css).toMatch(/\.inbox-detail-header\s*\{[^}]*padding:\s*12px 16px 8px;/s);
    expect(css).toMatch(/\.inbox-detail-sender-row\s*\{[^}]*min-height:\s*32px;[^}]*margin-top:\s*6px;[^}]*padding-top:\s*6px;/s);
    expect(css).toMatch(/\.inbox-detail-row\s*\{[^}]*min-height:\s*28px;[^}]*padding:\s*4px 10px 4px 0;/s);
    expect(css).toMatch(/\.inbox-detail-value\s*\{[^}]*line-height:\s*16px;/s);
  });

  it('uses the shared small control size and themed segmented options in the inbox toolbar', () => {
    expect(inbox).toContain('className="inbox-action-bar"');
    expect(inbox).toContain('<Input');
    expect(inbox).toContain('size="small"');
    expect(inbox).toContain('<Segmented');
    expect(inbox).toContain('block');
    expect(inbox).toContain('className={`inbox-filter-tab${filter === f.key ? " is-active" : ""}`}');
    expect(inbox).toContain('onClick={fetching ? () => setFetchProgressOpen(true) : doFetch}');
    expect(inbox).toContain('<Button size="small" onClick={batchRead}');
    expect(inbox).toContain('<Button size="small" danger onClick={batchDel}');
    expect(css).toMatch(/\.inbox-action-bar\s*\{[^}]*gap:\s*8px;[^}]*padding:\s*10px 12px 8px;/s);
    expect(css).toMatch(/\.inbox-action-bar \.ant-btn,[\s\S]*?font-size:\s*12px;/);
    expect(css).toMatch(/\.inbox-filter-tab\.is-active\s*\{[^}]*box-shadow:\s*inset 0 -1\.5px 0 var\(--workspace-text\);/s);
  });
});
