import { describe, expect, it } from 'vitest';
import { chatInput } from '../../server/transport/ai-http';

const messages = [{ role: 'user', content: 'hello' }];

describe('AI chat input', () => {
  it('defaults OpenAI-compatible agent requests to the agent feature', () => {
    expect(chatInput({ model: 'center-managed', messages })).toMatchObject({ feature: 'agent' });
  });

  it('keeps explicit features and rejects unknown ones', () => {
    expect(chatInput({ feature: 'draft', messages })).toMatchObject({ feature: 'draft' });
    expect(chatInput({ feature: 'unknown', messages })).toBeNull();
  });

  it('accepts optional assistant content with tool calls and text-part content', () => {
    const parsed = chatInput({ messages: [
      { role: 'user', content: [{ type: 'text', text: 'weather?' }] },
      { role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }] },
    ] });
    expect(parsed?.messages[0]?.content).toBe('weather?');
    expect(parsed?.messages[1]).toMatchObject({ role: 'assistant', content: null });
  });
});
