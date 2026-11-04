// Minimal static file server for e2e tests: serves a directory that can be
// swapped at runtime, so one test can serve build v1 and then build v2 from the
// same origin (a service worker update needs an unchanged scope).

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

async function resolve(root, pathname) {
  const target = path.join(root, pathname);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  try {
    const info = await stat(target);
    if (info.isFile()) return { file: target, size: info.size };
  } catch {
    // missing: fall through to 404
  }
  return null;
}

export function startStaticServer({ root }) {
  let current = root;

  const server = createServer(async (request, response) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
    } catch {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('bad request\n');
      return;
    }
    if (pathname.endsWith('/')) pathname += 'index.html';

    const found = await resolve(current, pathname);
    if (!found) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('not found\n');
      return;
    }

    response.writeHead(200, {
      'Content-Type': TYPES[path.extname(found.file)] ?? 'application/octet-stream',
      'Content-Length': found.size,
      'Cache-Control': 'no-cache',
    });
    createReadStream(found.file).pipe(response);
  });

  return new Promise((resolveStart, rejectStart) => {
    server.once('error', rejectStart);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectStart);
      const { port } = server.address();
      resolveStart({
        url: `http://127.0.0.1:${port}`,
        setRoot(dir) {
          current = dir;
        },
        close() {
          return new Promise((resolveClose, rejectClose) => {
            server.close((error) => (error ? rejectClose(error) : resolveClose()));
          });
        },
      });
    });
  });
}
