import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const appLayout = readFileSync(resolve(root, 'src/renderer/components/layout/AppLayout.tsx'), 'utf8');
const inbox = readFileSync(resolve(root, 'src/renderer/pages/inbox/InboxList.tsx'), 'utf8');
const css = readFileSync(resolve(root, 'src/renderer/global.css'), 'utf8');

describe('inbox full-screen layout', () => {
  it('lets the inbox consume the remaining app workspace without an outer page scroll', () => {
    expect(appLayout).toContain("const EDGE_TO_EDGE_PATHS = new Set(['/inbox'])") ;
    expect(appLayout).toContain('app-scroll-area--edge-to-edge');
    expect(appLayout).toContain('app-route-content--edge-to-edge');
    expect(css).toMatch(/\.app-scroll-area--edge-to-edge\s*\{[^}]*padding:\s*0;/s);
    expect(css).toMatch(/\.app-scroll-area--edge-to-edge\s*\{[^}]*overflow:\s*hidden;/s);
    expect(css).toMatch(/\.app-route-content--edge-to-edge\s*\{[^}]*height:\s*100%;/s);
  });

  it('gives the reading pane more room while keeping the mail list readable', () => {
    expect(inbox).toContain('width: "34%"');
    expect(inbox).toContain('minWidth: 360');
    expect(inbox).toContain('maxWidth: 620');
    expect(inbox).not.toContain('width: "40%"');
    expect(inbox).not.toContain('minWidth: 340');
  });

  it('uses the full available height while keeping each pane internally scrollable', () => {
    expect(inbox).toContain('className="inbox-workspace prospector-inbox-page flex h-full"');
    expect(inbox).not.toContain('calc(100vh - 130px)');
    expect(css).toMatch(/\.inbox-workspace\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*min-height:\s*0;/s);
  });
});
