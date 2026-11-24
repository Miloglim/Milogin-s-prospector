import { describe, expect, it } from 'vitest';
import { resolveMailAiMode } from '../../src/main/core/inbox-ai-mode';

describe('inbox mail AI mode', () => {
  it('keeps live mode when no test mode is requested', () => {
    expect(resolveMailAiMode({ requested: undefined, development: true })).toBe('live');
    expect(resolveMailAiMode({ requested: 'live', development: true })).toBe('live');
  });

  it('allows mock and off only in development', () => {
    expect(resolveMailAiMode({ requested: 'mock', development: true })).toBe('mock');
    expect(resolveMailAiMode({ requested: 'off', development: true })).toBe('off');
    expect(resolveMailAiMode({ requested: 'mock', development: false })).toBe('live');
    expect(resolveMailAiMode({ requested: 'off', development: false })).toBe('live');
  });
});
