// Static file server for dist/ used by Playwright (and manual smoke checks).
// SPA fallback to index.html, correct MIME types, /healthz for parity with nginx.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const port = Number(process.env.PORT ?? 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function sendText(response, status, body, type = 'text/plain; charset=utf-8') {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  response.end(body);
}

async function resolveFile(pathname) {
  const target = path.join(root, pathname);
  if (!target.startsWith(root + path.sep) && target !== root) return null;
  try {
    const info = await stat(target);
    if (info.isFile()) return { file: target, size: info.size };
  } catch {
    // fall through
  }
  return null;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

  if (url.pathname === '/healthz') {
    sendText(response, 200, 'ok\n');
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    sendText(response, 400, 'bad request\n');
    return;
  }

  if (pathname.endsWith('/')) pathname += 'index.html';

  let found = await resolveFile(pathname);
  // SPA fallback for extensionless routes.
  if (!found && !path.extname(pathname)) {
    found = await resolveFile('/index.html');
  }
  if (!found) {
    sendText(response, 404, 'not found\n');
    return;
  }

  const type = MIME[path.extname(found.file)] ?? 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Accept-Ranges': 'bytes' };

  // Byte ranges: without them Chromium cannot seek an <audio> element, so a
  // local trial of the tonearm / platter scrub would always snap back to 0.
  const range = request.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (match) {
      const start = match[1] === '' ? Math.max(found.size - Number(match[2]), 0) : Number(match[1]);
      const end = match[1] !== '' && match[2] !== '' ? Math.min(Number(match[2]), found.size - 1) : found.size - 1;
      if (start <= end && start < found.size) {
        response.writeHead(206, {
          ...headers,
          'Content-Range': `bytes ${start}-${end}/${found.size}`,
          'Content-Length': end - start + 1,
        });
        createReadStream(found.file, { start, end }).pipe(response);
        return;
      }
    }
  }

  response.writeHead(200, { ...headers, 'Content-Length': found.size });
  createReadStream(found.file).pipe(response);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`serving ${root} on http://127.0.0.1:${port}`);
});
