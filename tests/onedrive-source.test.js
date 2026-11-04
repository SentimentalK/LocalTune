import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OneDriveSource } from '../src/core/sources/onedrive/source.js';
import { createRemoteFile } from '../src/core/sources/onedrive/remoteFile.js';

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

function memorySession(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem(key) {
      return map.get(key) ?? null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
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
  };
}

function validToken(extra = {}) {
  return {
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: Date.now() + 3600 * 1000,
    scope: 'Files.Read',
    ...extra,
  };
}

function makeSource({
  meta = memoryMeta(),
  fetchImpl = async () => {
    throw new Error('unexpected fetch');
  },
  cache = null,
  sessionStore = memorySession(),
  location = fakeLocation(),
  history = fakeHistory(),
  now,
} = {}) {
  return new OneDriveSource({ meta, fetchImpl, cache, sessionStore, location, history, now });
}

function bytesOf(buffer) {
  return Array.from(new Uint8Array(buffer));
}

test('restore reports none without a token and prompt for an expired one', async () => {
  const meta = memoryMeta();
  const source = makeSource({ meta });

  assert.equal(await source.restore(), 'none');
  assert.equal(source.permission(), 'none');
  assert.equal(source.hasRoot(), false);

  meta.map.set('onedriveToken', { accessToken: 'old', expiresAt: 1 });
  assert.equal(await source.restore(), 'prompt');
  assert.equal(source.permission(), 'prompt');
});

test('handleRedirect exchanges the code, stores the token and clears the query', async () => {
  const meta = memoryMeta();
  const sessionStore = memorySession({
    'localtune:onedrive:pkce': JSON.stringify({
      verifier: 'verifier',
      state: 'state-1',
      redirectUri: 'https://app.test/',
    }),
  });
  const location = fakeLocation({ search: '?code=code-1&state=state-1' });
  const history = fakeHistory();
  const calls = [];
  const source = makeSource({
    meta,
    sessionStore,
    location,
    history,
    fetchImpl: async (url, init) => {
      calls.push([url, init]);
      return jsonResponse(200, {
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
        scope: 'Files.Read',
      });
    },
  });

  assert.equal(await source.handleRedirect(), true);
  assert.equal(calls.length, 1);
  assert.ok(calls[0][0].endsWith('/token'));
  assert.equal(meta.map.get('onedriveToken').accessToken, 'new-access');
  assert.ok(Number.isFinite(meta.map.get('onedriveAuthAt')));
  assert.equal(sessionStore.map.has('localtune:onedrive:pkce'), false);
  assert.equal(history.calls.length, 1);
  assert.equal(history.calls[0][2], '/');
  assert.ok(!history.calls[0][2].includes('?'));
});

test('handleRedirect rejects a state mismatch without storing a token', async () => {
  const meta = memoryMeta();
  const sessionStore = memorySession({
    'localtune:onedrive:pkce': JSON.stringify({
      verifier: 'verifier',
      state: 'expected',
      redirectUri: 'https://app.test/',
    }),
  });
  const location = fakeLocation({ search: '?code=code-1&state=other' });
  const history = fakeHistory();
  const source = makeSource({ meta, sessionStore, location, history });

  assert.equal(await source.handleRedirect(), false);
  assert.equal(meta.map.has('onedriveToken'), false);
  assert.equal(sessionStore.map.has('localtune:onedrive:pkce'), false);
  assert.equal(history.calls.length, 1);
  assert.equal(source.authError, 'state mismatch');
});

test('silentReauth redirects with prompt=none once per ten minutes', async () => {
  const location = fakeLocation();
  const sessionStore = memorySession();
  const source = makeSource({ location, sessionStore });

  assert.equal(await source.silentReauth(), 'redirecting');
  assert.equal(location.assigned.length, 1);
  assert.match(location.assigned[0], /login\.microsoftonline\.com/);
  assert.match(location.assigned[0], /prompt=none/);
  assert.ok(sessionStore.map.has('localtune:onedrive:silent'));

  assert.equal(await source.silentReauth(), false);
  assert.equal(location.assigned.length, 1);
});

test('getFile returns a cached blob without touching auth or the network', async () => {
  const meta = memoryMeta({
    onedriveToken: { accessToken: 'expired', expiresAt: 1 },
    onedriveRoot: { driveId: 'drive-1', itemId: 'root', path: '', name: 'OneDrive' },
  });
  const cached = new Blob(['cached']);
  const reads = [];
  const cache = {
    read: async (key) => {
      reads.push(key);
      return cached;
    },
    write: async () => {},
  };
  let fetchCalls = 0;
  let permissionCalls = 0;
  const source = makeSource({
    meta,
    cache,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('must not fetch');
    },
  });
  await source.restore();
  source.ensurePermission = async () => {
    permissionCalls += 1;
    return true;
  };

  const file = await source.getFile('a.mp3');
  assert.equal(file, cached);
  assert.deepEqual(reads, ['onedrive:a.mp3']);
  assert.equal(permissionCalls, 0);
  assert.equal(fetchCalls, 0);
});

test('_fetchRange refetches the download URL once after a failed range request', async () => {
  const meta = memoryMeta({
    onedriveToken: validToken(),
    onedriveRoot: { driveId: 'drive-1', itemId: 'root', path: '', name: 'OneDrive' },
  });
  const itemCalls = [];
  const rangeCalls = [];
  const source = makeSource({
    meta,
    fetchImpl: async (url, init = {}) => {
      if (init.headers?.Range) {
        rangeCalls.push(init.headers.Range);
        if (rangeCalls.length === 1) return { status: 403, ok: false };
        return {
          status: 206,
          ok: true,
          async arrayBuffer() {
            return new Uint8Array([1, 2, 3, 4]).buffer;
          },
        };
      }
      itemCalls.push(url);
      return jsonResponse(200, {
        id: 'item-1',
        '@microsoft.graph.downloadUrl': `https://download.test/${itemCalls.length}`,
      });
    },
  });
  await source.restore();

  const result = await source._fetchRange('item-1', 0, 3);
  assert.equal(result.status, 206);
  assert.deepEqual(Array.from(result.bytes), [1, 2, 3, 4]);
  assert.equal(rangeCalls.length, 2);
  assert.equal(itemCalls.length, 2);
});

test('_fetchRange throws when both range attempts fail', async () => {
  const meta = memoryMeta({
    onedriveToken: validToken(),
    onedriveRoot: { driveId: 'drive-1', itemId: 'root', path: '', name: 'OneDrive' },
  });
  const source = makeSource({
    meta,
    fetchImpl: async (url, init = {}) => {
      if (init.headers?.Range) return { status: 403, ok: false };
      return jsonResponse(200, {
        id: 'item-1',
        '@microsoft.graph.downloadUrl': 'https://download.test/file',
      });
    },
  });
  await source.restore();

  await assert.rejects(source._fetchRange('item-1', 0, 3), /HTTP 403/);
});

test('ensurePermission refreshes an expired token and clears an invalid grant', async () => {
  const meta = memoryMeta({
    onedriveToken: { accessToken: 'old', refreshToken: 'refresh', expiresAt: 1 },
  });
  const source = makeSource({
    meta,
    fetchImpl: async () =>
      jsonResponse(200, {
        access_token: 'fresh',
        refresh_token: 'refresh-2',
        expires_in: 3600,
      }),
  });
  await source.restore();

  assert.equal(await source.ensurePermission(), true);
  assert.equal(meta.map.get('onedriveToken').accessToken, 'fresh');
  assert.equal(source.permission(), 'granted');

  const rejected = memoryMeta({
    onedriveToken: { accessToken: 'old', refreshToken: 'refresh', expiresAt: 1 },
  });
  const failing = makeSource({
    meta: rejected,
    fetchImpl: async () => jsonResponse(400, { error: 'invalid_grant' }),
  });
  await failing.restore();

  assert.equal(await failing.ensurePermission(), false);
  assert.equal(failing.permission(), 'prompt');
  assert.equal(rejected.map.get('onedriveToken'), null);
});

test('scan walks pages and subfolders, filters non-audio and persists item ids', async () => {
  const meta = memoryMeta({
    onedriveToken: validToken(),
    onedriveRoot: { driveId: 'drive-1', itemId: 'root', path: '', name: 'OneDrive' },
  });
  const nextLink = 'https://graph.microsoft.com/v1.0/next';
  const item = (id, name, extra = {}) => ({
    id,
    name,
    size: 1234,
    lastModifiedDateTime: '2024-01-02T03:04:05Z',
    ...extra,
  });
  const source = makeSource({
    meta,
    fetchImpl: async (url) => {
      if (url === nextLink) {
        return jsonResponse(200, {
          value: [
            item('a2', 'b.mp3', { file: { mimeType: 'audio/mpeg' } }),
            item('t1', 'notes.txt', { file: { mimeType: 'text/plain' } }),
            item('h1', '.hidden', { folder: { childCount: 0 } }),
          ],
        });
      }
      if (url.includes('/items/dir1/children')) {
        return jsonResponse(200, { value: [] });
      }
      return jsonResponse(200, {
        value: [
          item('dir1', 'Albums', { folder: { childCount: 0 } }),
          item('a1', 'a.mp3', { file: { mimeType: 'audio/mpeg' } }),
        ],
        '@odata.nextLink': nextLink,
      });
    },
  });
  await source.restore();

  const seen = [];
  for await (const entry of source.scan()) seen.push(entry);

  assert.deepEqual(
    seen.map((entry) => entry.path),
    ['a.mp3', 'b.mp3'],
  );
  assert.deepEqual(
    seen.map((entry) => entry.externalIds.onedrive),
    ['a1', 'a2'],
  );
  assert.equal(seen[0].mtime, Date.parse('2024-01-02T03:04:05Z'));
  assert.equal(seen[0].size, 1234);
  assert.deepEqual(meta.map.get('onedriveItems'), {
    'a.mp3': 'a1',
    'b.mp3': 'a2',
    'notes.txt': 't1',
  });
});

test('getFile downloads a whole file on a cache miss and writes the cache', async () => {
  const meta = memoryMeta({
    onedriveToken: validToken(),
    onedriveRoot: { driveId: 'drive-1', itemId: 'root', path: '', name: 'OneDrive' },
    onedriveItems: { 'a.mp3': 'item-1' },
  });
  const blob = new Blob(['audio']);
  const writes = [];
  const wholeCalls = [];
  const source = makeSource({
    meta,
    cache: {
      read: async () => null,
      write: async (row) => {
        writes.push(row);
      },
    },
    fetchImpl: async (url, init = {}) => {
      if (init.headers?.Range) throw new Error('unexpected range');
      if (url.startsWith('https://download.test/')) {
        wholeCalls.push(url);
        return { status: 200, ok: true, async blob() { return blob; } };
      }
      return jsonResponse(200, {
        id: 'item-1',
        '@microsoft.graph.downloadUrl': 'https://download.test/file',
      });
    },
  });
  await source.restore();

  const file = await source.getFile('a.mp3');
  assert.equal(file, blob);
  assert.equal(wholeCalls.length, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].key, 'onedrive:a.mp3');
  assert.equal(writes[0].source, 'onedrive');
  assert.equal(writes[0].path, 'a.mp3');
  assert.equal(writes[0].blob, blob);
});

test('browse lists only folders sorted by name at the drive root', async () => {
  const meta = memoryMeta({
    onedriveToken: validToken(),
    onedriveRoot: { driveId: 'drive-1', itemId: 'root', path: '', name: 'OneDrive' },
    onedriveItems: { Music: 'music-1' },
  });
  const urls = [];
  const source = makeSource({
    meta,
    fetchImpl: async (url) => {
      urls.push(url);
      return jsonResponse(200, {
        value: [
          { id: 'z', name: 'Zeta', folder: { childCount: 0 } },
          { id: 'a', name: 'Alpha', folder: { childCount: 0 } },
          { id: 'f', name: 'song.mp3', file: { mimeType: 'audio/mpeg' } },
        ],
      });
    },
  });
  await source.restore();

  const root = await source.browse('');
  assert.deepEqual(
    root.map((entry) => entry.name),
    ['Alpha', 'Zeta'],
  );
  assert.deepEqual(
    root.map((entry) => entry.path),
    ['Alpha', 'Zeta'],
  );
  assert.ok(root.every((entry) => entry.isFolder));
  assert.ok(urls.some((url) => url.includes('/drives/drive-1/root/children')));
});

test('browse resolves paths from the drive root, not the chosen library root', async () => {
  const meta = memoryMeta({
    onedriveToken: validToken(),
    onedriveRoot: { driveId: 'drive-1', itemId: 'folder-music', path: 'Music', name: 'Music' },
    // A root-relative map must not leak into picker navigation.
    onedriveItems: { Music: 'wrong-item' },
  });
  const urls = [];
  const source = makeSource({
    meta,
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.includes('/root:/Music:')) {
        return jsonResponse(200, { id: 'folder-music', name: 'Music', folder: { childCount: 2 } });
      }
      if (url.includes('/items/folder-music/children')) {
        return jsonResponse(200, {
          value: [
            { id: 'sub', name: 'Sub', folder: { childCount: 0 } },
            { id: 'albums', name: 'Albums', folder: { childCount: 0 } },
          ],
        });
      }
      throw new Error(`unexpected request ${url}`);
    },
  });
  await source.restore();

  const folders = await source.browse('Music');

  assert.deepEqual(
    folders.map((entry) => entry.name),
    ['Albums', 'Sub'],
  );
  assert.deepEqual(
    folders.map((entry) => entry.path),
    ['Music/Albums', 'Music/Sub'],
  );
  assert.ok(urls.some((url) => url.includes('/drives/drive-1/root:/Music:')));
  assert.ok(urls.every((url) => !url.includes('Music/Music')));
  assert.ok(urls.every((url) => !url.includes('/items/wrong-item/')));
});

test('browse resolves nested drive paths with every segment encoded', async () => {
  const meta = memoryMeta({
    onedriveToken: validToken(),
    onedriveRoot: { driveId: 'drive-1', itemId: 'folder-music', path: 'Music', name: 'Music' },
  });
  const urls = [];
  const source = makeSource({
    meta,
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.includes('/root:/Music/Sub:')) {
        return jsonResponse(200, { id: 'folder-sub', name: 'Sub', folder: { childCount: 0 } });
      }
      if (url.includes('/items/folder-sub/children')) return jsonResponse(200, { value: [] });
      throw new Error(`unexpected request ${url}`);
    },
  });
  await source.restore();

  assert.deepEqual(await source.browse('Music/Sub'), []);
  assert.ok(urls.some((url) => url.includes('/drives/drive-1/root:/Music/Sub:')));
  assert.ok(urls.every((url) => !url.includes('Music/Music')));
});

test('createRemoteFile prefetches head and tail and reuses both buffers', async () => {
  const calls = [];
  const bytes = new Uint8Array(400000);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251;
  const file = createRemoteFile({
    name: 'big.mp3',
    size: bytes.length,
    headBytes: 10,
    tailBytes: 5,
    fetchRange: async (start, end) => {
      calls.push([start, end]);
      return { status: 206, bytes: bytes.slice(start, end + 1) };
    },
  });

  assert.equal(file.name, 'big.mp3');
  assert.equal(file.size, 400000);

  const head = file.slice(0, 2);
  assert.equal(head.size, 2);
  assert.deepEqual(bytesOf(await head.arrayBuffer()), [0, 1]);
  assert.deepEqual(calls, [
    [0, 9],
    [399995, 399999],
  ]);

  const tail = file.slice(399996, 399998);
  assert.deepEqual(bytesOf(await tail.arrayBuffer()), [
    bytes[399996],
    bytes[399997],
  ]);
  assert.equal(calls.length, 2);

  const middle = file.slice(100, 103);
  assert.deepEqual(bytesOf(await middle.arrayBuffer()), [bytes[100], bytes[101], bytes[102]]);
  assert.deepEqual(calls[2], [100, 102]);
});

test('createRemoteFile keeps a small whole-file response as the buffer', async () => {
  const bytes = new Uint8Array([0, 1, 2, 3, 4, 5]);
  const calls = [];
  const file = createRemoteFile({
    name: 'small.mp3',
    size: bytes.length,
    headBytes: 4,
    tailBytes: 2,
    fetchRange: async (start, end) => {
      calls.push([start, end]);
      return { status: 200, bytes };
    },
  });

  assert.deepEqual(bytesOf(await file.slice(1, 3).arrayBuffer()), [1, 2]);
  assert.deepEqual(bytesOf(await file.slice(4, 6).arrayBuffer()), [4, 5]);
  assert.equal(calls.length, 1);
});

test('createRemoteFile rejects a whole-file response above maxRangeBytes', async () => {
  const file = createRemoteFile({
    name: 'huge.mp3',
    size: 1000,
    headBytes: 10,
    maxRangeBytes: 4,
    fetchRange: async () => ({ status: 200, bytes: new Uint8Array(5) }),
  });

  await assert.rejects(file.slice(0, 1).arrayBuffer(), /range ignored for large file/);
});
