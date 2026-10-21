import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const login = readFileSync(resolve(root, 'src/renderer/components/ProductLogin.tsx'), 'utf8');
const loginCss = readFileSync(resolve(root, 'src/renderer/components/ProductLogin.css'), 'utf8');
const layout = readFileSync(resolve(root, 'src/renderer/components/layout/AppLayout.tsx'), 'utf8');

describe('integrated login titlebar', () => {
  it('uses the black titlebar variant on the login screen', () => {
    expect(login).toContain("<TitleBar tone={workspaceDark ? 'dark' : 'light'} transparent />");
    expect(layout).toContain("tone = 'dark'");
    expect(layout).toContain("transparent = false");
    expect(layout).toContain('app-titlebar--transparent');
    expect(loginCss).toContain('body.workspace-dark .product-login');
    expect(loginCss).toContain('body.workspace-dark .product-login-main');
  });
});
