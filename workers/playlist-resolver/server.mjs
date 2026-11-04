// Node HTTP entry point for the playlist resolver. The Worker handler stays
// runtime-agnostic; this file only bridges node:http <-> fetch Request/Response.
//
// Privacy: like the Worker, request URLs are never logged.

import { createServer as createHttpServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import { createHandler } from './src/index.js';
import { createMemoryCache } from './src/memory-cache.js';

/**
 * `/api/xxx` -> `/xxx`; everything else is returned unchanged. `/api` itself
 * is passed through so the handler answers 404.
 */
export function stripApiPrefix(pathname) {
  if (pathname.startsWith('/api/')) return pathname.slice(4);
  return pathname;
}

/**
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   cache?: ReturnType<typeof createMemoryCache>,
 *   now?: () => number,
 *   rateLimit?: { windowMs?: number, max?: number },
 * }} options
 */
export function createServer({ fetchImpl = fetch, cache = createMemoryCache(), now = Date.now, rateLimit } = {}) {
  const handler = createHandler({ fetchImpl, cache, now, rateLimit });

  return createHttpServer(async (req, res) => {
    try {
      const host = req.headers.host ?? '127.0.0.1';
      const original = new URL(req.url ?? '/', `http://${host}`);
      const pathname = stripApiPrefix(original.pathname);

      // Liveness bypasses the handler entirely: no cache, no rate limit.
      if (pathname === '/healthz') {
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end('ok');
        return;
      }

      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(name, value);
      }
      if (!headers.has('cf-connecting-ip')) {
        const forwarded = headers.get('x-forwarded-for');
        headers.set(
          'cf-connecting-ip',
          forwarded
            ? forwarded.split(',')[0].trim()
            : (req.socket.remoteAddress ?? 'anonymous'),
        );
      }

      const request = new Request(new URL(pathname + original.search, `http://${host}`), {
        method: req.method,
        headers,
      });
      const response = await handler(request);

      const body = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, response.statusText, Object.fromEntries(response.headers));
      res.end(body);
    } catch {
      // Never log URLs, bodies or headers.
      console.log({ error: true });
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      }
      res.end(JSON.stringify({ error: 'internal' }));
    }
  });
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const PORT = Number(process.env.PORT ?? 8787);
  const HOST = process.env.HOST ?? '0.0.0.0';
  const server = createServer();

  server.listen(PORT, HOST, () => {
    console.log({ listen: PORT });
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
