import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const appLayout = readFileSync(resolve(root, 'src/renderer/components/layout/AppLayout.tsx'), 'utf8');
const inbox = readFileSync(resolve(root, 'src/renderer/pages/inbox/InboxList.tsx'), 'utf8');
const css = readFileSync(resolve(root, 'src/renderer/global.css'), 'utf8');

describe('inbox full-screen layout', () => {
  it('keeps the inbox edge-to-edge while giving its panes internal scrolling', () => {
    expect(appLayout).toContain("const EDGE_TO_EDGE_PATHS = new Set(['/inbox', '/team'])") ;
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

  it('uses account scopes and renders a dedicated todo queue', () => {
    expect(inbox).toContain('const [accountFilter, setAccountFilter]');
    expect(inbox).toContain('accountGroups.length > 1');
    expect(inbox).toContain('inbox-management-account${');
    expect(inbox).toContain('inbox-todo-row is-${priority}');
    expect(inbox).not.toContain('业务分类');
    expect(inbox).toContain('className="inbox-todo-overview"');
    expect(inbox).toContain('一键已处理');
    expect(inbox).toContain('inbox:todoStateBatch');
    expect(inbox).not.toContain('基础功能');
    expect(inbox).not.toContain('更多');
    expect(inbox).not.toContain('title="需核对"');
    expect(inbox).not.toContain('inbox-management-more-heading');
    expect(inbox).not.toContain('inbox-management-more-toggle');
    expect(inbox).toContain('title="待办"');
    expect(inbox).toContain('<CheckSquareOutlined /><span>待办</span>');
    expect(inbox).not.toContain('todoShowDone');
    expect(inbox).not.toContain('inbox-clean-status-dot');
    expect(css).not.toContain('.inbox-management-ai-label');
    expect(css).toMatch(/\.inbox-todo-row\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 30px;/s);
  });

  it('keeps unread emphasis light and aligns subject, sender and analysis rows', () => {
    expect(inbox).toContain('className={`inbox-mail-row${');
    expect(inbox).toContain('className="inbox-mail-copy"');
    expect(css).toMatch(/\.inbox-mail-type-dot\s*\{[^}]*width:\s*5px;[^}]*height:\s*5px;/s);
    expect(css).toMatch(/\.inbox-mail-copy\s*\{[^}]*grid-template-rows:\s*19px 17px 17px;/s);
    expect(css).toMatch(/\.inbox-mail-row\.is-unread \.inbox-mail-subject\s*\{[^}]*font-weight:\s*600;/s);
    expect(css).toMatch(/\.inbox-mail-row\.is-read \.inbox-mail-subject\s*\{[^}]*color:\s*#111827;/s);
    expect(css).toMatch(/\.inbox-mail-row\.is-read \.inbox-mail-sender-name\s*\{[^}]*color:\s*#69737c;/s);
    expect(css).toMatch(/\.inbox-mail-row\.is-read \.inbox-mail-analysis-row\s*\{[^}]*color:\s*#707a83;/s);
    expect(css).not.toMatch(/\.inbox-mail-row\.is-read[^{]*\{[^}]*opacity:/s);
    expect(inbox).not.toContain('className="inbox-mail-type-slot"');
    expect(inbox).toContain('className="inbox-mail-type-label"');
    expect(inbox).toContain('className="inbox-mail-analysis-tag"');
    expect(css).toMatch(/\.inbox-mail-analysis-tag\s*\{[^}]*min-height:\s*16px;[^}]*border-left:\s*2px solid #a7aeb5;[^}]*background:\s*#f7f8f9;[^}]*font-size:\s*9px;/s);
    expect(inbox).toContain('className="inbox-mail-analysis-ai"');
  });

  it('keeps contact summary text out of the narrow status rail', () => {
    expect(css).toMatch(/\.inbox-contact-row\s*\{[^}]*grid-template-rows:\s*auto auto auto;/s);
    expect(css).toMatch(/\.inbox-contact-row-summary\s*\{[^}]*grid-column:\s*1;[^}]*grid-row:\s*2;/s);
    expect(css).toMatch(/\.inbox-contact-row-meta\s*\{[^}]*grid-column:\s*1;[^}]*grid-row:\s*3;/s);
    expect(css).toMatch(/\.inbox-contact-row-signals\s*\{[^}]*grid-column:\s*2;[^}]*grid-row:\s*1 \/ span 3;/s);
    expect(inbox).not.toContain('inbox-contact-row-email');
    expect(css).not.toContain('.inbox-contact-row-email');
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
    expect(css).toMatch(/\.inbox-detail-value\s*\{[^}]*line-height:\s*17px;/s);
  });

  it('uses compact controls and a themed mail/contact view switch in the inbox toolbar', () => {
    expect(inbox).toContain('className="inbox-action-bar"');
    expect(inbox).toContain('<Input');
    expect(inbox).toContain('size="small"');
    expect(inbox).toContain('className="inbox-view-switch"');
    expect(css).toMatch(/\.inbox-view-switch\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/s);
    expect(inbox).toContain('className="inbox-management-pane"');
    expect(inbox).toContain('className={`inbox-management-item${');
    expect(inbox).not.toContain('title="已匹配联系人"');
    expect(inbox).toContain('title="新建文件夹"');
    expect(inbox).not.toContain('title="全部置顶邮件"');
    expect(inbox).toContain('aria-expanded={pinnedFolderOpen}');
    expect(inbox).toContain('className="inbox-folder-mail-row"');
    expect(inbox).not.toContain('inbox-folder-toggle');
    expect(inbox).toContain('aria-expanded={foldersOpen}');
    expect(inbox).toContain('<FolderOutlined /><span>{label.name}</span>');
    expect(inbox).toContain('inbox:messageLabels');
    expect(inbox).not.toContain('{"dot" in f');
    expect(inbox).toContain('onClick={syncRunning ? () => setFetchProgressOpen(true) : doFetch}');
    expect(inbox).toContain('已拉取 ${row.current} / 共需拉取 ${row.required}');
    expect(inbox).toContain('<Button onClick={() => setFetchProgressOpen(false)}>{syncRows.some(row => row.failed) ? "关闭" : "转入后台"}</Button>');
    expect(inbox).toContain('<Button size="small" onClick={batchRead}');
    expect(inbox).toContain('<Button size="small" danger onClick={batchDel}');
    expect(css).toMatch(/\.inbox-action-bar\s*\{[^}]*gap:\s*8px;[^}]*padding:\s*10px 12px 8px;/s);
    expect(css).toMatch(/\.inbox-action-bar \.ant-btn,[\s\S]*?font-size:\s*12px;/);
    expect(css).toMatch(/\.inbox-management-pane\s*\{[^}]*width:\s*208px;[^}]*flex:\s*0 0 208px;/s);
    expect(css).toMatch(/\.inbox-management-item\.is-active\s*\{[^}]*box-shadow:\s*inset 2px 0 #1677ff;/s);
  });

  it('collapses the management rail before it squeezes the mail list and reader', () => {
    expect(css).toContain('@media (max-width: 940px)');
    expect(css).toMatch(/\.inbox-management-pane\s*\{[^}]*width:\s*52px;[^}]*flex-basis:\s*52px;/s);
    expect(css).toMatch(/\.inbox-list-pane\s*\{[^}]*width:\s*44% !important;[^}]*min-width:\s*330px !important;/s);
  });
});
