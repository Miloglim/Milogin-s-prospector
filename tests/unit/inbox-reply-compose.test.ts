import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('inbox reply compose', () => {
  it('sends replies in-app instead of handing them to the system mail client', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/pages/inbox/InboxList.tsx'), 'utf8');
    expect(source).toContain("window.api.invoke('inbox:reply'");
    expect(source).not.toContain('mailto:');
    expect(source).toContain('title="回复邮件"');
  });
});
