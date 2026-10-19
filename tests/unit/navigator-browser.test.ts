import { it, expect } from 'vitest';
import { browserAuthorization } from '../../src/main/adapters/navigator-browser.adapter';
it('rejects a mismatched state and accepts only the exact callback path', async () => {
  const flow = browserAuthorization('https://navigator.test', async (url) => {
    const auth = new URL(url);
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    expect(auth.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const callback = auth.searchParams.get('redirect_uri')!;
    expect((await fetch(callback+'?state=wrong&code=secret')).status).toBe(400);
    expect((await fetch(callback.replace('/navigator/callback','/other'))).status).toBe(404);
    expect((await fetch(callback+'?state='+auth.searchParams.get('state')+'&code=one-time')).status).toBe(200);
  });
  expect(await flow).toMatchObject({code:'one-time'});
});
