// Offline stand-in for Microsoft identity, Graph and downloadUrl hosts.
// Everything the OneDrive source needs is served from one fixture file; the
// recorder exposes whole-file downloads so a spec can prove playback fetched
// the track exactly once.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AUDIO = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures', 'sample.mp3'),
);

const DEFAULT_FILES = [
  { id: 'track-1', name: 'one.mp3' },
  { id: 'track-2', name: 'two.mp3' },
];

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, range, content-type',
};

function json(route, status, body) {
  return route.fulfill({
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function driveItem(file) {
  return {
    id: file.id,
    name: file.name,
    size: AUDIO.length,
    lastModifiedDateTime: '2024-01-02T03:04:05Z',
    file: { mimeType: 'audio/mpeg' },
    '@microsoft.graph.downloadUrl': `https://download.test/${encodeURIComponent(file.id)}`,
  };
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {{ files?: Array<{ id: string, name: string }> }} [options]
 */
export async function installGraphMock(page, { files = DEFAULT_FILES } = {}) {
  const state = { wholeRequests: [], authorizeRequests: [] };

  await page.route('https://login.microsoftonline.com/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname.endsWith('/token')) {
      return route.fulfill({
        status: 200,
        headers: { ...CORS, 'content-type': 'application/json' },
        body: JSON.stringify({
          access_token: 'mock-access-token',
          refresh_token: 'mock-refresh-token',
          expires_in: 3600,
          scope: 'Files.Read',
        }),
      });
    }

    state.authorizeRequests.push(url.href);
    const redirect = new URL(url.searchParams.get('redirect_uri') ?? 'http://127.0.0.1:4173/');
    redirect.searchParams.set('code', 'mock-code');
    redirect.searchParams.set('state', url.searchParams.get('state') ?? '');
    return route.fulfill({
      status: 302,
      headers: { location: redirect.href },
      body: '',
    });
  });

  await page.route('https://graph.microsoft.com/**', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: CORS });
    }

    const url = new URL(request.url());
    let pathname = url.pathname;
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      // Keep the raw path; no fixture name needs decoding.
    }

    if (pathname === '/v1.0/me/drive') return json(route, 200, { id: 'drive-1' });

    if (
      pathname === '/v1.0/drives/drive-1/root/children' ||
      pathname === '/v1.0/drives/drive-1/items/root/children'
    ) {
      return json(route, 200, {
        value: [
          {
            id: 'folder-music',
            name: 'Music',
            folder: { childCount: files.length },
            lastModifiedDateTime: '2024-01-02T03:04:05Z',
            size: 0,
          },
        ],
      });
    }

    if (pathname === '/v1.0/drives/drive-1/root:/Music:') {
      return json(route, 200, {
        id: 'folder-music',
        name: 'Music',
        folder: { childCount: files.length },
        lastModifiedDateTime: '2024-01-02T03:04:05Z',
        size: 0,
      });
    }

    if (pathname === '/v1.0/drives/drive-1/items/folder-music/children') {
      return json(route, 200, { value: files.map(driveItem) });
    }

    const itemMatch = /^\/v1\.0\/drives\/drive-1\/items\/([^/]+)$/.exec(pathname);
    if (itemMatch) {
      const file = files.find((entry) => entry.id === itemMatch[1]);
      if (file) return json(route, 200, driveItem(file));
    }

    return json(route, 404, { error: { code: 'itemNotFound', message: 'not found' } });
  });

  await page.route('https://download.test/**', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: CORS });
    }

    const range = request.headers().range;
    const headers = {
      ...CORS,
      'content-type': 'audio/mpeg',
      'accept-ranges': 'bytes',
    };

    if (!range) {
      state.wholeRequests.push(request.url());
      return route.fulfill({ status: 200, headers, body: AUDIO });
    }

    const match = /bytes=(\d+)-(\d*)/.exec(range);
    const start = Number(match?.[1] ?? 0);
    const end = Math.min(Number(match?.[2] || AUDIO.length - 1), AUDIO.length - 1);
    const body = AUDIO.subarray(start, end + 1);
    return route.fulfill({
      status: 206,
      headers: { ...headers, 'content-range': `bytes ${start}-${end}/${AUDIO.length}` },
      body,
    });
  });

  return state;
}
