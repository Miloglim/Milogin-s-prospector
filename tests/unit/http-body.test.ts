import { describe, expect, it } from 'vitest';
import { createServer, request as httpRequest } from 'node:http';
import { body, send } from '../../server/transport/http';

const LIMIT_BYTES = 1024;
const OVERSIZED_BYTES = LIMIT_BYTES * 2048;

describe('bounded HTTP body rejection', () => {
  it.each([true, false])('drains an oversized upload before replying 413 (declared length: %s)', async declared => {
    let requestCompleted = false;
    const server = createServer((request, response) => {
      void body(request, LIMIT_BYTES).then(result => {
        requestCompleted = request.complete;
        send(response, result);
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const payload = JSON.stringify({ source: 'x'.repeat(OVERSIZED_BYTES) });
      const result = await new Promise<{ status: number; value: unknown }>((resolve, reject) => {
        const client = httpRequest({ host: '127.0.0.1', port: (server.address() as { port: number }).port, method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(declared ? { 'Content-Length': Buffer.byteLength(payload) } : {}) } }, response => {
          let json = '';
          response.setEncoding('utf8');
          response.on('data', chunk => { json += chunk; });
          response.on('error', reject);
          response.on('end', () => resolve({ status: response.statusCode!, value: JSON.parse(json) }));
        });
        client.on('error', reject);
        client.end(payload);
      });
      expect(result).toEqual({ status: 413, value: { ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: '请求体超限' } } });
      expect(requestCompleted).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
