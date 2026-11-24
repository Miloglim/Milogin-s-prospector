import { describe, expect, it } from 'vitest';
import { normalizedResponse, responsesInput } from '../../server/services/ai';

describe('AI tool bridge', () => {
  it('converts Responses function calls into chat-completions tool calls', () => {
    const result = normalizedResponse({ output: [{ type: 'function_call', call_id: 'call-1', name: 'get_weather', arguments: '{"city":"Shanghai"}' }] });
    expect(result.choices[0]).toMatchObject({ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'call-1', function: { name: 'get_weather', arguments: '{"city":"Shanghai"}' } }] } });
  });

  it('converts chat history with tool calls and tool results for Responses', () => {
    const input = responsesInput([
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Shanghai"}' } }] },
      { role: 'tool', content: '20C', tool_call_id: 'call-1' },
    ]);
    expect(input).toEqual([
      { role: 'user', content: 'weather?' },
      { type: 'function_call', call_id: 'call-1', name: 'get_weather', arguments: '{"city":"Shanghai"}' },
      { type: 'function_call_output', call_id: 'call-1', output: '20C' },
    ]);
  });

  it('keeps plain Responses text as message content', () => {
    const result = normalizedResponse({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }] });
    expect(result.choices[0]).toMatchObject({ finish_reason: 'stop', message: { content: 'done' } });
  });

  it('strips leaked think tags from assistant text', () => {
    const result = normalizedResponse({ output_text: '<think></think>今天没有新邮件。' });
    expect(result.outputText).toBe('今天没有新邮件。');
  });
});
