// Offline stand-in for Google Identity Services and the Drive v3 API.
// The token model is stubbed so no popup is ever opened; listing is served
// from an in-memory tree with forced pagination, and media reads return one
// fixture MP3. Recorders expose every request a spec needs to prove that a
// cached track plays without another download.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AUDIO = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures', 'sample.mp3'),
);

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DEFAULT_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';

const DEFAULT_FOLDERS = [{ id: 'folder-music', name: 'Music', parentId: 'root' }];
const DEFAULT_FILES = [
  { id: 'track-1', name: 'one.mp3', parentId: 'folder-music', mimeType: 'audio/mpeg' },
  { id: 'track-2', name: 'two.mp3', parentId: 'folder-music', mimeType: 'audio/mpeg' },
  { id: 'notes-1', name: 'notes.txt', parentId: 'folder-music', mimeType: 'text/plain' },
];

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'authorization, range, content-type',
};

function json(route, status, body) {
  return route.fulfill({
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function parentOf(query) {
  const match = /'((?:[^'\\]|\\.)*)' in parents/.exec(query ?? '');
  return match ? match[1].replace(/\\(.)/g, '$1') : null;
}

function nameOf(query) {
  const match = /name = '((?:[^'\\]|\\.)*)'/.exec(query ?? '');
  return match ? match[1].replace(/\\(.)/g, '$1') : null;
}

function driveItem(entry) {
  return {
    id: entry.id,
    name: entry.name,
    mimeType: entry.mimeType ?? FOLDER_MIME,
    size: entry.mimeType === FOLDER_MIME ? undefined : String(AUDIO.length),
    modifiedTime: '2024-01-02T03:04:05Z',
    parents: [entry.parentId],
  };
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {{
 *   files?: Array<{ id: string, name: string, parentId?: string, mimeType?: string }>,
 *   folders?: Array<{ id: string, name: string, parentId?: string }>,
 *   pageSize?: number,
 *   clientId?: string,
 * }} [options]
 */
export async function installGdriveMock(
  page,
  {
    files = DEFAULT_FILES,
    folders = DEFAULT_FOLDERS,
    pageSize = 1,
    clientId = DEFAULT_CLIENT_ID,
  } = {},
) {
  const folderTree = folders.map((folder) => ({
    ...folder,
    mimeType: FOLDER_MIME,
  }));
  const fileTree = files.map((file) => ({
    parentId: 'root',
    mimeType: 'audio/mpeg',
    ...file,
  }));

  const mock = {
    listRequests: [],
    mediaRequests: [],
    tokenRequests: 0,
    reject401: false,
  };

  await page.addInitScript((id) => {
    window.__LT_GOOGLE_CLIENT_ID__ = id;
  }, clientId);

  await page.route('https://accounts.google.com/gsi/client', async (route) => {
    mock.tokenRequests += 1;
    return route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/javascript; charset=utf-8' },
      body: `
        window.google = window.google || {};
        window.google.accounts = window.google.accounts || {};
        window.google.accounts.oauth2 = {
          initTokenClient: ({ callback }) => ({
            requestAccessToken: () => setTimeout(() => callback({
              access_token: 'gdrive-token',
              expires_in: 3600,
              scope: 'https://www.googleapis.com/auth/drive.readonly',
            }), 0),
          }),
        };
      `,
    });
  });

  await page.route('https://www.googleapis.com/**', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: CORS });
    }

    const url = new URL(request.url());
    const isMedia = url.searchParams.get('alt') === 'media';

    if (mock.reject401) {
      return json(route, 401, { error: { code: 401, message: 'Invalid Credentials' } });
    }

    if (isMedia) {
      mock.mediaRequests.push(request.url());
      return route.fulfill({
        status: 200,
        headers: { ...CORS, 'content-type': 'audio/mpeg' },
        body: AUDIO,
      });
    }

    const authorization = request.headers()['authorization'] ?? '';
    mock.listRequests.push({ url: request.url(), authorization });

    const parentId = parentOf(url.searchParams.get('q'));
    const wantedName = nameOf(url.searchParams.get('q'));
    const folderOnly = (url.searchParams.get('q') ?? '').includes(FOLDER_MIME);

    let children = [...folderTree, ...(folderOnly ? [] : fileTree)].filter(
      (entry) => entry.parentId === parentId,
    );
    if (wantedName) children = children.filter((entry) => entry.name === wantedName);
    children.sort((a, b) => a.name.localeCompare(b.name));

    // Force pagination regardless of the requested pageSize so the client's
    // nextPageToken loop is exercised on every listing.
    const pageToken = url.searchParams.get('pageToken');
    const offset = pageToken == null ? 0 : Number(pageToken);
    if (!Number.isInteger(offset) || offset < 0 || offset > children.length) {
      return json(route, 400, { error: { code: 400, message: 'Invalid pageToken' } });
    }
    const page = children.slice(offset, offset + pageSize);
    const next = offset + pageSize < children.length ? String(offset + pageSize) : undefined;

    return json(route, 200, {
      files: page.map(driveItem),
      ...(next ? { nextPageToken: next } : {}),
    });
  });

  return mock;
}
