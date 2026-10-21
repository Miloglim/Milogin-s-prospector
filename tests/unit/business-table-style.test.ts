import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const app = readFileSync(resolve(root, 'src/renderer/App.tsx'), 'utf8');
const templates = readFileSync(resolve(root, 'src/renderer/pages/templates/TemplateList.tsx'), 'utf8');
const css = readFileSync(resolve(root, 'src/renderer/global.css'), 'utf8');

describe('business table presentation', () => {
  it('uses one branded empty state for Ant Design collections and tables', () => {
    expect(app).toContain('renderEmpty={() => <AppEmptyState />}');
    expect(app).toContain('暂无数据');
    expect(css).toMatch(/\.app-empty-state\s*\{[^}]*min-height:\s*96px;/s);
    expect(css).toMatch(/\.ant-empty::before\s*\{[^}]*content:\s*"◇";/s);
  });

  it('keeps the template library on the shared table density and width rules', () => {
    expect(templates).toContain('className="prospector-page-table template-list-table"');
    expect(templates).toContain('size="small"');
    expect(templates).toContain('scroll={{ x: 960 }}');
    expect(templates).not.toContain('size="middle"');
  });
});
