// Offline stand-in for Dropbox OAuth, the RPC API and the content API.
// The token model is stubbed so the authorize redirect never leaves the page;
// listing is served from an in-memory tree with forced pagination, and media
// reads return one fixture MP3. Recorders expose every request a spec needs to
// prove that a cached track plays without another download.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AUDIO = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures', 'sample.mp3'),
);

const DEFAULT_FOLDERS = [{ id: 'id:folder-music', name: 'Music', path: '/Music' }];
const DEFAULT_FILES = [
  { id: 'id:one', name: 'one.mp3', path: '/Music/one.mp3' },
  { id: 'id:two', name: 'two.mp3', path: '/Music/two.mp3' },
  { id: 'id:notes', name: 'notes.txt', path: '/Music/notes.txt' },
];

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, dropbox-api-arg',
};

function json(route, status, body) {
  return route.fulfill({
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function normalizePath(value) {
  return `/${String(value ?? '')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean)
    .join('/')}`.replace(/^\/$/, '');
}

function parentOf(value) {
  const clean = normalizePath(value);
  const cut = clean.lastIndexOf('/');
  return cut <= 0 ? '' : clean.slice(0, cut);
}

function basenameOf(value) {
  const clean = normalizePath(value);
  return clean.slice(clean.lastIndexOf('/') + 1);
}

function folderEntry(folder) {
  return {
    '.tag': 'folder',
    id: folder.id,
    name: folder.name,
    path_display: folder.path,
    path_lower: folder.path.toLowerCase(),
  };
}

function fileEntry(file) {
  return {
    '.tag': 'file',
    id: file.id,
    name: file.name,
    size: AUDIO.length,
    server_modified: '2024-01-02T03:04:05Z',
    path_display: file.path,
    path_lower: file.path.toLowerCase(),
  };
}

function parseCursor(value) {
  try {
    const [folder, offset, recursive] = String(value ?? '').split('|');
    const parsed = Number(offset);
    return {
      folder,
      offset: Number.isInteger(parsed) && parsed >= 0 ? parsed : 0,
      recursive: recursive === 'true',
    };
  } catch {
    return { folder: '', offset: 0, recursive: false };
  }
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {{
 *   files?: Array<{ id: string, name: string, path?: string }>,
 *   folders?: Array<{ id: string, name: string, path?: string }>,
 *   pageSize?: number,
 *   appKey?: string,
 *   refreshOk?: boolean,
 * }} [options]
 */
export async function installDropboxMock(
  page,
  {
    files = DEFAULT_FILES,
    folders = DEFAULT_FOLDERS,
    pageSize = 1,
    appKey = 'test-app-key',
    refreshOk = true,
  } = {},
) {
  const folderTree = folders.map((folder) => ({
    ...folder,
    path: normalizePath(folder.path ?? `/${folder.name}`),
  }));
  const fileTree = files.map((file) => ({
    ...file,
    path: normalizePath(file.path ?? `/${file.name}`),
  }));
  const all = [...folderTree.map(folderEntry), ...fileTree.map(fileEntry)];

  const mock = {
    authorizeUrls: [],
    tokenRequests: [],
    listRequests: [],
    mediaRequests: [],
    reject401: '',
    refreshOk,
  };

  await page.addInitScript((key) => {
    window.__LT_DROPBOX_APP_KEY__ = key;
  }, appKey);

  /** `reject401` is mutable: 'once' fails one non-token request, 'always' all. */
  function rejectOnce() {
    if (mock.reject401 === 'always') return true;
    if (mock.reject401 === 'once') {
      mock.reject401 = '';
      return true;
    }
    return false;
  }

  function listing(folder, recursive, offset) {
    const base = normalizePath(folder);
    const prefix = base === '' ? '' : `${base.toLowerCase()}/`;
    const matches = all
      .filter((entry) => {
        if (recursive) {
          if (base === '') return true;
          return entry.path_lower.startsWith(prefix);
        }
        return parentOf(entry.path_lower) === base.toLowerCase();
      })
      .sort((left, right) => left.path_lower.localeCompare(right.path_lower));
    const pageEntries = matches.slice(offset, offset + pageSize);
    const next = offset + pageSize < matches.length ? `${folder}|${offset + pageSize}|${recursive}` : undefined;
    return {
      entries: pageEntries,
      ...(next ? { has_more: true, cursor: next } : { has_more: false }),
    };
  }

  await page.route('https://www.dropbox.com/oauth2/authorize**', async (route) => {
    const url = route.request().url();
    mock.authorizeUrls.push(url);
    const params = new URL(url).searchParams;
    const target = new URL(params.get('redirect_uri') || '/');
    target.searchParams.set('code', 'mock-code');
    target.searchParams.set('state', params.get('state') ?? '');
    return route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: `<script>location.replace(${JSON.stringify(target.toString())})</script>`,
    });
  });

  await page.route('https://api.dropboxapi.com/oauth2/token', async (route) => {
    const request = route.request();
    const body = new URLSearchParams(request.postData() ?? '');
    const record = { grant: body.get('grant_type'), body: Object.fromEntries(body) };
    mock.tokenRequests.push(record);

    if (record.grant === 'refresh_token' && !mock.refreshOk) {
      return json(route, 400, {
        error: 'invalid_grant',
        error_description: 'refresh token is invalid or revoked',
      });
    }
    if (record.grant === 'refresh_token') {
      return json(route, 200, {
        access_token: 'dbx-access-2',
        expires_in: 14400,
        token_type: 'bearer',
        scope: 'files.metadata.read files.content.read',
      });
    }
    return json(route, 200, {
      access_token: 'dbx-access-1',
      refresh_token: 'dbx-refresh-1',
      expires_in: 14400,
      token_type: 'bearer',
      scope: 'files.metadata.read files.content.read',
      account_id: 'dbid:test',
      uid: '1',
    });
  });

  await page.route('https://api.dropboxapi.com/2/files/list_folder**', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: CORS });
    }
    const authorization = request.headers()['authorization'] ?? '';
    const endpoint = new URL(request.url()).pathname.replace('/2', '');
    const body = JSON.parse(request.postData() ?? '{}');
    mock.listRequests.push({ endpoint, body, authorization });

    if (rejectOnce()) {
      return json(route, 401, {
        error_summary: 'expired_access_token/...',
        error: { '.tag': 'expired_access_token' },
      });
    }

    if (endpoint.endsWith('/files/list_folder/continue')) {
      const cursor = parseCursor(body.cursor);
      return json(route, 200, listing(cursor.folder, cursor.recursive, cursor.offset));
    }
    return json(
      route,
      200,
      listing(body.path ?? '', body.recursive === true, 0),
    );
  });

  await page.route('https://content.dropboxapi.com/2/files/download', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: CORS });
    }
    const authorization = request.headers()['authorization'] ?? '';
    let apiPath = '';
    try {
      apiPath = JSON.parse(request.headers()['dropbox-api-arg'] ?? '{}').path ?? '';
    } catch {
      apiPath = '';
    }
    mock.mediaRequests.push({ path: apiPath, authorization });

    if (rejectOnce()) {
      return json(route, 401, {
        error_summary: 'expired_access_token/...',
        error: { '.tag': 'expired_access_token' },
      });
    }

    return route.fulfill({
      status: 200,
      headers: {
        ...CORS,
        'content-type': 'audio/mpeg',
        'Dropbox-API-Result': JSON.stringify({
          name: basenameOf(apiPath),
          path_display: apiPath,
          size: AUDIO.length,
        }),
      },
      body: AUDIO,
    });
  });

  return mock;
}
