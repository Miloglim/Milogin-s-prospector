import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const sendCenter = readFileSync(resolve(root, 'src/renderer/pages/campaigns/SendCenter.tsx'), 'utf8');
const sidebar = readFileSync(resolve(root, 'src/renderer/components/layout/Sidebar.tsx'), 'utf8');
const router = readFileSync(resolve(root, 'src/renderer/router.tsx'), 'utf8');

describe('send center template tab', () => {
  it('keeps the material library inside send center and removes the duplicate sidebar entry', () => {
    expect(sendCenter).toContain('import { TemplateList } from "../templates/TemplateList"');
    expect(sendCenter).toContain('{ key: "templates", label: "素材库", children: <TemplateList /> }');
    expect(sidebar).not.toContain('label: "素材库"');
    expect(router).toContain("path: \"/templates\"");
    expect(router).toContain("throw redirect({ to: '/campaigns', search: { tab: 'templates' } })");
  });
});
