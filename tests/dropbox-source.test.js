import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DropboxSource } from '../src/core/sources/dropbox/source.js';
import { DropboxAuthError } from '../src/core/sources/dropbox/auth.js';
import { DropboxError } from '../src/core/sources/dropbox/client.js';

function memoryMeta(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    get(key) {
      return Promise.resolve(map.get(key) ?? null);
    },
    set(key, value) {
      map.set(key, value);
      return Promise.resolve();
    },
  };
}

function fakeLocation(overrides = {}) {
  return {
    origin: 'https://app.test',
    pathname: '/',
    search: '',
    hash: '',
    assigned: [],
    assign(url) {
      this.assigned.push(url);
    },
    ...overrides,
  };
}

function fakeHistory() {
  const calls = [];
  return {
    calls,
    replaceState(state, title, url) {
      calls.push([state, title, url]);
    },
  };
}

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function blobResponse(status, blob = new Blob(['audio'])) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async blob() {
      return blob;
    },
    headers: { get: () => null },
  };
}

function validToken(extra = {}) {
  return {
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: Date.now() + 3_600_000,
    scope: 'files.metadata.read files.content.read',
    ...extra,
  };
}

function makeSource({
  meta = memoryMeta(),
  fetchImpl = async () => {
    throw new Error(`unexpected fetch`);
  },
  cache = null,
  location = fakeLocation(),
  history = fakeHistory(),
  appKey = 'test-app-key',
  now,
} = {}) {
  return new DropboxSource({ meta, fetchImpl, cache, location, history, appKey, now });
}

test('startLogin rejects a blank app key without network or navigation', async () => {
  for (const appKey of ['', '   ']) {
    const location = fakeLocation();
    const calls = [];
    const source = makeSource({
      appKey,
      location,
      fetchImpl: async (...args) => {
        calls.push(args);
        throw new Error('unexpected fetch');
      },
    });

    await assert.rejects(source.startLogin(), (error) => {
      assert.ok(error instanceof DropboxAuthError);
      assert.equal(error.code, 'not_configured');
      return true;
    });
    assert.equal(calls.length, 0);
    assert.deepEqual(location.assigned, []);
  }
});

test('startLogin stores PKCE and redirects with offline S256 parameters', async () => {
  const meta = memoryMeta();
  const location = fakeLocation();
  const source = makeSource({ meta, location });

  assert.equal(await source.startLogin(), 'redirecting');

  const pkce = meta.map.get('dropboxPkce');
  assert.equal(typeof pkce.verifier, 'string');
  assert.ok(pkce.verifier.length > 0);
  assert.equal(typeof pkce.state, 'string');
  assert.ok(pkce.state.length > 0);
  assert.equal(pkce.redirectUri, 'https://app.test/');
  assert.ok(Number.isFinite(pkce.at));

  assert.equal(location.assigned.length, 1);
  const authorize = new URL(location.assigned[0]);
  assert.equal(authorize.searchParams.get('client_id'), 'test-app-key');
  assert.equal(authorize.searchParams.get('token_access_type'), 'offline');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorize.searchParams.get('code_challenge').length > 0, true);
  assert.equal(authorize.searchParams.get('state'), pkce.state);
});

test('browse lists only folders, sorted, and merges pages', async () => {
  const pages = [
    {
      entries: [
        { '.tag': 'folder', id: 'f-z', name: 'Zeta' },
        { '.tag': 'file', id: 'file-1', name: 'song.mp3' },
        { '.tag': 'folder', id: 'f-a', name: 'Albums' },
      ],
      has_more: true,
      cursor: 'c1',
    },
    { entries: [{ '.tag': 'folder', id: 'f-b', name: 'Beta' }], has_more: false },
  ];
  let pageIndex = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/files/list_folder')) {
      pageIndex += 1;
      return jsonResponse(200, pages[0]);
    }
    if (url.endsWith('/files/list_folder/continue')) {
      pageIndex += 1;
      return jsonResponse(200, pages[1]);
    }
    throw new Error(`unexpected url ${url}`);
  };
  const source = makeSource({ fetchImpl });
  source._token = validToken();

  const folders = await source.browse('');

  assert.deepEqual(folders, [
    { id: 'f-a', name: 'Albums', path: 'Albums', isFolder: true },
    { id: 'f-b', name: 'Beta', path: 'Beta', isFolder: true },
    { id: 'f-z', name: 'Zeta', path: 'Zeta', isFolder: true },
  ]);
  assert.equal(pageIndex, 2);
});

test('scan yields only audio under the chosen root with root-relative paths', async () => {
  const fetchImpl = async (url, init) => {
    if (!url.endsWith('/files/list_folder')) throw new Error(`unexpected url ${url}`);
    assert.deepEqual(JSON.parse(init.body), {
      path: '/Music',
      recursive: true,
      limit: 1000,
      include_deleted: false,
      include_non_downloadable_files: false,
    });
    return jsonResponse(200, {
      entries: [
        { '.tag': 'folder', id: 'f-albums', name: 'Albums', path_display: '/Music/Albums' },
        {
          '.tag': 'file',
          id: 'id-a',
          name: 'a.mp3',
          size: 1234,
          server_modified: '2024-01-02T03:04:05Z',
          path_display: '/Music/a.mp3',
        },
        {
          '.tag': 'file',
          id: 'id-b',
          name: 'b.flac',
          size: 4321,
          server_modified: '2024-02-03T04:05:06Z',
          path_display: '/Music/Albums/b.flac',
        },
        {
          '.tag': 'file',
          id: 'id-out',
          name: 'out.mp3',
          size: 9,
          server_modified: '2024-01-02T03:04:05Z',
          path_display: '/Other/out.mp3',
        },
        {
          '.tag': 'file',
          id: 'id-notes',
          name: 'notes.txt',
          size: 10,
          server_modified: '2024-01-02T03:04:05Z',
          path_display: '/Music/notes.txt',
        },
        { '.tag': 'deleted', name: 'gone.mp3', path_display: '/Music/gone.mp3' },
        {
          '.tag': 'file',
          id: 'id-hidden',
          name: '.hidden.mp3',
          size: 10,
          server_modified: '2024-01-02T03:04:05Z',
          path_display: '/Music/.hidden.mp3',
        },
      ],
      has_more: false,
    });
  };
  const meta = memoryMeta();
  const source = makeSource({ meta, fetchImpl });
  source._token = validToken();
  await source.setRoot({ id: 'id:folder-music', path: 'Music', name: 'Music' });

  const rows = [];
  for await (const entry of source.scan()) rows.push(entry);

  assert.deepEqual(
    rows.map((row) => row.path),
    ['a.mp3', 'Albums/b.flac'],
  );
  assert.equal(rows[0].path, 'a.mp3');
  assert.equal(rows[0].size, 1234);
  assert.equal(rows[0].mtime, Date.parse('2024-01-02T03:04:05Z'));
  assert.deepEqual(rows[0].externalIds, { dropbox: 'id-a' });
  assert.equal(typeof rows[0].readFile, 'function');
  assert.equal(meta.map.get('dropboxItems')['a.mp3'], 'id-a');
  assert.equal(meta.map.get('dropboxItems')['Albums/b.flac'], 'id-b');
});

test('setRoot and forget persist and clear the root round-trip', async () => {
  const meta = memoryMeta();
  const source = makeSource({ meta });

  const root = await source.setRoot({ id: 'id:folder', path: '/Music/', name: 'Music' });
  assert.deepEqual(root, { id: 'id:folder', path: 'Music', name: 'Music' });
  assert.equal(meta.map.get('dropboxRoot').path, 'Music');
  assert.equal(source.permission(), 'granted');

  await source.forget();

  assert.equal(meta.map.get('dropboxRoot'), null);
  assert.equal(meta.map.get('dropboxToken'), null);
  assert.equal(source.permission(), 'none');
  assert.equal(source.hasRoot(), false);
  assert.equal(source.name, '');
});

test('ensurePermission refreshes once and keeps the old refresh token', async () => {
  const meta = memoryMeta({
    dropboxToken: {
      accessToken: 'expired',
      refreshToken: 'old-refresh',
      expiresAt: 1,
      scope: 'files.metadata.read files.content.read',
    },
  });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: init.body });
    return jsonResponse(200, { access_token: 'fresh', expires_in: 14400 });
  };
  const source = makeSource({ meta, fetchImpl });
  await source.restore();

  assert.equal(await source.ensurePermission(), true);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.dropboxapi.com/oauth2/token');
  const body = new URLSearchParams(calls[0].body);
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('refresh_token'), 'old-refresh');
  assert.equal(source.permission(), 'granted');
  assert.equal(source._token.accessToken, 'fresh');
  assert.equal(source._token.refreshToken, 'old-refresh');
  assert.equal(meta.map.get('dropboxToken').refreshToken, 'old-refresh');
});

test('ensurePermission clears a revoked token and reports prompt', async () => {
  const meta = memoryMeta({
    dropboxToken: {
      accessToken: 'expired',
      refreshToken: 'revoked',
      expiresAt: 1,
      scope: '',
    },
  });
  const fetchImpl = async () =>
    jsonResponse(400, {
      error: 'invalid_grant',
      error_description: 'refresh token is invalid or revoked',
    });
  const source = makeSource({ meta, fetchImpl });
  await source.restore();

  assert.equal(await source.ensurePermission(), false);
  assert.equal(source.permission(), 'prompt');
  assert.equal(source._token, null);
  assert.equal(meta.map.get('dropboxToken'), null);
});

test('getFile refreshes after a 401 and retries the download once', async () => {
  let downloads = 0;
  let tokens = 0;
  const fetchImpl = async (url) => {
    if (url === 'https://api.dropboxapi.com/oauth2/token') {
      tokens += 1;
      return jsonResponse(200, { access_token: 'dbx-access-2', expires_in: 14400 });
    }
    if (url === 'https://content.dropboxapi.com/2/files/download') {
      downloads += 1;
      return downloads === 1 ? jsonResponse(401, { error_summary: 'expired_access_token/...' }) : blobResponse(200, new Blob(['audio']));
    }
    throw new Error(`unexpected url ${url}`);
  };
  const source = makeSource({ fetchImpl });
  source._token = validToken();
  source._root = { id: 'id:folder', path: 'Music', name: 'Music' };
  source._items['a.mp3'] = 'id-a';

  const blob = await source.getFile('a.mp3');

  assert.equal(blob.size, 5);
  assert.equal(downloads, 2);
  assert.equal(tokens, 1);
  assert.equal(source.permission(), 'granted');
});

test('getFile rejects when the 401 refresh fails', async () => {
  const fetchImpl = async (url) => {
    if (url === 'https://api.dropboxapi.com/oauth2/token') {
      return jsonResponse(400, { error: 'invalid_grant' });
    }
    return jsonResponse(401, { error_summary: 'expired_access_token/...' });
  };
  const source = makeSource({ fetchImpl });
  source._token = validToken();
  source._root = { id: 'id:folder', path: 'Music', name: 'Music' };
  source._items['a.mp3'] = 'id-a';

  await assert.rejects(source.getFile('a.mp3'), (error) => {
    assert.ok(error instanceof DropboxError);
    assert.equal(error.status, 401);
    return true;
  });
  assert.equal(source.permission(), 'prompt');
});

test('getFile plays from the cache without a token or a fetch', async () => {
  const cached = new Blob(['cached']);
  const fetches = [];
  const cache = {
    async read() {
      return cached;
    },
    async write() {
      throw new Error('write must not run for a cache hit');
    },
  };
  const source = makeSource({
    cache,
    fetchImpl: async (...args) => {
      fetches.push(args);
      throw new Error('unexpected fetch');
    },
  });
  source._token = { accessToken: 'expired', refreshToken: 'dead', expiresAt: 1 };

  const blob = await source.getFile('Music/a.mp3');

  assert.equal(blob, cached);
  assert.equal(fetches.length, 0);
});

test('configured is false for a blank app key', () => {
  assert.equal(makeSource({ appKey: '' }).configured(), false);
  assert.equal(makeSource({ appKey: '   ' }).configured(), false);
  assert.equal(makeSource({ appKey: 'key' }).configured(), true);
});
