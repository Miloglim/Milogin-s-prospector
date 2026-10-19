import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { NAVIGATOR_CALLBACK_PATH, NAVIGATOR_CLIENT_ID } from '../../shared/navigator';
const LOGIN_TIMEOUT_SECONDS = 180;
const MILLISECONDS_PER_SECOND = 1000;
const PKCE_BYTES = 32;
export function browserAuthorization(base: string, openBrowser: (url:string) => Promise<void>): Promise<{code:string;verifier:string;redirectUri:string}> {
  return new Promise((resolve,reject) => {
    const state = randomBytes(PKCE_BYTES).toString('base64url');
    const verifier = randomBytes(PKCE_BYTES).toString('base64url');
    let redirectUri = '';
    let finished = false;
    const finish = (error?: Error, code?:string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      server.close(); server.closeAllConnections();
      if (error) reject(error); else resolve({code:code!,verifier,redirectUri});
    };
    const server = createServer((req,res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      res.setHeader('Content-Type','text/plain; charset=utf-8');
      res.setHeader('Cache-Control','no-store');
      if (url.pathname !== NAVIGATOR_CALLBACK_PATH || req.method !== 'GET') {res.writeHead(404);res.end('Not found');return;}
      const received = url.searchParams.get('state') ?? '';
      const equalState = Buffer.byteLength(received) === Buffer.byteLength(state) && timingSafeEqual(Buffer.from(received),Buffer.from(state));
      if (!equalState || url.searchParams.getAll('state').length !== 1) {res.writeHead(400);res.end('Invalid authorization state');return;}
      const code = url.searchParams.get('code');
      if (!code || url.searchParams.getAll('code').length !== 1 || url.searchParams.has('error')) {
        res.writeHead(400);res.end('Authorization cancelled');finish(new Error('Authorization cancelled'));return;
      }
      res.end('Navigator 授权完成，可以关闭此窗口并返回 Prospector。');
      // Close after the response has been flushed; credentials never appear in response HTML.
      res.on('finish',() => finish(undefined,code));
    });
    const timer = setTimeout(() => finish(new Error('Authorization timeout')),LOGIN_TIMEOUT_SECONDS*MILLISECONDS_PER_SECOND);
    server.on('error',() => finish(new Error('Loopback callback failed')));
    server.listen(0,'127.0.0.1',() => {
      const address = server.address();
      if (!address || typeof address === 'string') {finish(new Error('Invalid callback address'));return;}
      redirectUri = `http://127.0.0.1:${address.port}${NAVIGATOR_CALLBACK_PATH}`;
      const url = new URL('/api/prospector/authorize',base);
      url.search = new URLSearchParams({response_type:'code',client_id:NAVIGATOR_CLIENT_ID,redirect_uri:redirectUri,state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}).toString();
      void openBrowser(url.href).catch(() => finish(new Error('Browser launch failed')));
    });
  });
}
