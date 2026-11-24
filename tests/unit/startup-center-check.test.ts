import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('development startup center check', () => {
  it('starts the local center before the desktop app', () => {
    const start = readFileSync(join(process.cwd(), 'start.bat'), 'utf8');
    const ensure = readFileSync(join(process.cwd(), 'scripts/ensure-center.ps1'), 'utf8');
    expect(start).toContain('scripts\\ensure-center.ps1');
    expect(start).toContain('chcp 65001');
    expect(ensure).toContain('http://127.0.0.1:55847/health/ready');
    expect(ensure).toContain('scripts/center-postgres.mjs start');
    expect(ensure).toContain('npm run crm:production:start');
    const dev = readFileSync(join(process.cwd(), 'scripts/dev-single.mjs'), 'utf8');
    expect(dev).toContain("chcp.com");
  });
});
