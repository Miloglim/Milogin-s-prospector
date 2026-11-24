import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('assistant model status', () => {
  it('does not call retired local endpoint channels', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/pages/assistant/AssistantPage.tsx'), 'utf8');
    expect(source).not.toContain('ai:endpointStatus');
    expect(source).not.toContain('ai:profileActivate');
  });
});
