import { describe, it, expect } from 'vitest';
import { NavigatorContextPolicy } from '../../src/main/services/navigator-context.service';
describe('Navigator context privacy', () => {
  it('keeps ordinary conversations unchanged across logout', () => {
    const policy = new NavigatorContextPolicy(1000);
    expect(policy.visible({createdAt:'1970-01-01T00:00:00Z',content:'Please summarize my contacts'},false)).toBe(true);
  });
  it('blocks historical rate conversations even after the same user logs in', () => {
    const policy = new NavigatorContextPolicy(1000);
    policy.reset(true,2000);
    expect(policy.visible({createdAt:'1970-01-01T00:00:01Z',content:'Earlier answer'},true)).toBe(false);
    expect(policy.visible({createdAt:'1970-01-01T00:00:03Z',content:'Current answer'},true)).toBe(true);
  });
  it('fails closed for legacy prices without tool provenance', () => {
    const policy = new NavigatorContextPolicy(1000);
    expect(policy.visible({createdAt:'1970-01-01T00:00:00Z',content:'SANTOS USD 2500 / 40HQ'},false)).toBe(false);
  });
  it('invalidates current authorized data and in-flight epochs on logout', () => {
    const policy = new NavigatorContextPolicy(1000);
    policy.reset(true,2000);
    const epoch = policy.epoch;
    policy.reset(false,4000);
    expect(policy.current(epoch)).toBe(false);
    expect(policy.visible({createdAt:'1970-01-01T00:00:03Z',content:'USD 2500'},true)).toBe(false);
  });
  it('suppresses rate facts and draft payloads but keeps ordinary email work', () => {
    const policy = new NavigatorContextPolicy(1000);
    expect(policy.visible({kind:'draft',toolName:'generate_draft',payloadJson:'{"rates":[{"price":500}]}',createdAt:'1970-01-01T00:00:00Z'},false)).toBe(false);
    expect(policy.visible({kind:'email',contextLine:'Meeting tomorrow',createdAt:'1970-01-01T00:00:00Z'},false)).toBe(true);
  });
});
