import { readFileSync, readdirSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { brandTheme } from '../../src/renderer/lib/brand-theme';

describe('main interface typography', () => {
  it('uses the Windows UI font stack with a legible base scale', () => {
    const theme = brandTheme(false);
    expect(theme.token).toMatchObject({
      fontFamily: '"Noto Sans SC", "Segoe UI Variable Text", "Microsoft YaHei UI", "Segoe UI", sans-serif',
      fontSize: 14,
      fontSizeSM: 12,
      fontSizeLG: 16,
      fontWeightStrong: 600,
    });

    const css = readFileSync(resolve('src/renderer/global.css'), 'utf8');
    expect(css).toContain('--ui-font-family: "Noto Sans SC", "Segoe UI Variable Text", "Microsoft YaHei UI", "Segoe UI", sans-serif');
    expect(css).toMatch(/body\s*\{[^}]*font-family:\s*var\(--ui-font-family\)/s);
    expect(css).toMatch(/body\s*\{[^}]*font-size:\s*var\(--ui-font-size-base\)/s);
    expect(css).toMatch(/body\s*\{[^}]*font-synthesis:\s*none/s);
  });

  it('does not request synthesized intermediate font weights', () => {
    const root = resolve('src/renderer');
    const cssFiles = readdirSync(root, { recursive: true })
      .map(file => String(file))
      .filter(file => extname(file) === '.css');
    for (const file of cssFiles) {
      const css = readFileSync(resolve(root, file), 'utf8');
      expect(css, file).not.toMatch(/font-weight:\s*(550|620|650)\b/);
    }
  });
});
