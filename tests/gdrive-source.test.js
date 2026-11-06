import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GdriveSource } from '../src/core/sources/googledrive/source.js';
import { GdriveAuthError } from '../src/core/sources/googledrive/auth.js';
import {
  FOLDER_MIME,
  GdriveError,
  FILE_FIELDS,
} from '../src/core/sources/googledrive/drive.js';

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

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return body;
    },
  };
}

function bytesResponse(status, bytes) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
    async json() {
      return null;
    },
  };
}

function validToken(expiresAt = Date.now() + 3_600_000) {
  return {
    accessToken: 'access',
    expiresAt,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
  };
}

function makeSource({
  meta = memoryMeta(),
  fetchImpl = async () => {
    throw new Error('unexpected fetch');
  },
  cache = null,
  clientId = 'test-client',
  getGis = null,
  now,
} = {}) {
  return new GdriveSource({ meta, fetchImpl, cache, clientId, getGis, now });
}

function driveRequest(url) {
  const parsed = new URL(url);
  return {
    path: parsed.pathname,
    q: parsed.searchParams.get('q'),
    fields: parsed.searchParams.get('fields'),
    pageToken: parsed.searchParams.get('pageToken'),
    orderBy: parsed.searchParams.get('orderBy'),
    alt: parsed.searchParams.get('alt'),
  };
}

test('browse merges pages, keeps folders, sorts by name and returns root-relative paths', async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const request = driveRequest(url);
    requests.push({ ...request, headers: init.headers ?? {} });
    if (request.q?.includes("name = 'Music'")) {
      return jsonResponse(200, { files: [{ id: 'music-id', name: 'Music', mimeType: FOLDER_MIME }] });
    }
    if (request.q?.startsWith("'root' in parents")) {
      if (!request.pageToken) {
        return jsonResponse(200, {
          files: [
            { id: 'z', name: 'Zeta', mimeType: FOLDER_MIME },
            { id: 'blank', name: '', mimeType: FOLDER_MIME },
            { id: 'a', name: 'Alpha', mimeType: FOLDER_MIME },
          ],
          nextPageToken: 'page-2',
        });
      }
      return jsonResponse(200, {
        files: [{ id: 'b', name: 'Beta', mimeType: FOLDER_MIME }],
      });
    }
    if (request.q?.startsWith("'music-id' in parents")) {
      return jsonResponse(200, {
        files: [{ id: 'albums', name: 'Albums', mimeType: FOLDER_MIME }],
      });
    }
    throw new Error(`unexpected request: ${url}`);
  };
  const source = makeSource({ meta: memoryMeta({ gdriveToken: validToken() }), fetchImpl });
  await source.restore();

  const root = await source.browse();

  assert.deepEqual(root, [
    { id: 'a', name: 'Alpha', path: 'Alpha', isFolder: true },
    { id: 'b', name: 'Beta', path: 'Beta', isFolder: true },
    { id: 'z', name: 'Zeta', path: 'Zeta', isFolder: true },
  ]);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.headers.Authorization, 'Bearer access');
    assert.equal(request.orderBy, 'name');
    assert.equal(request.fields, 'nextPageToken,files(id,name,mimeType)');
  }
  assert.equal(requests[0].pageToken, null);
  assert.equal(requests[1].pageToken, 'page-2');

  const nested = await source.browse('Music');
  assert.deepEqual(nested, [{ id: 'albums', name: 'Albums', path: 'Music/Albums', isFolder: true }]);
  assert.equal(requests.length, 4);
  assert.equal(requests[2].q, "'root' in parents and name = 'Music' and mimeType = 'application/vnd.google-apps.folder' and trashed = false");
  assert.equal(requests[2].orderBy, null);
  assert.equal(requests[3].orderBy, 'name');
});

test('scan yields nested audio paths, falls back to extensions and persists the item map', async () => {
  const tree = {
    rootid: [
      {
        files: [
          {
            id: 'song',
            name: 'song.mp3',
            mimeType: 'application/octet-stream',
            size: '2048',
            modifiedTime: '2024-01-02T03:04:05.000Z',
          },
          { id: 'albums', name: 'Albums', mimeType: FOLDER_MIME },
          { id: 'notes', name: 'notes.txt', mimeType: 'text/plain', size: '10' },
        ],
        nextPageToken: 'rootid:1',
      },
      { files: [{ id: 'hidden', name: '.hidden.mp3', mimeType: 'audio/mpeg' }] },
    ],
    albums: [
      {
        files: [
          { id: 'track', name: 'track.flac', mimeType: 'application/octet-stream', size: 1024 },
          { id: 'clip', name: 'clip.bin', mimeType: 'audio/x-custom' },
          { id: 'sub', name: 'Sub', mimeType: FOLDER_MIME },
        ],
      },
    ],
    sub: [{ files: [{ id: 'deep', name: 'deep.ogg', mimeType: 'audio/ogg' }] }],
  };

  const requests = [];
  const fetchImpl = async (url) => {
    const request = driveRequest(url);
    requests.push(request);
    const match = /^'([^']*)' in parents/.exec(request.q ?? '');
    assert.ok(match, `unexpected query: ${request.q}`);
    const pages = tree[match[1]];
    assert.ok(pages, `unexpected parent: ${match[1]}`);
    const index = request.pageToken ? Number(request.pageToken.split(':')[1]) : 0;
    const page = pages[index];
    assert.ok(page, `unexpected page: ${request.pageToken}`);
    return jsonResponse(200, page);
  };

  const meta = memoryMeta({
    gdriveToken: validToken(),
    gdriveRoot: { id: 'rootid', path: '', name: 'Music' },
  });
  const source = makeSource({ meta, fetchImpl });
  await source.restore();

  const entries = [];
  for await (const entry of source.scan()) entries.push(entry);

  assert.deepEqual(
    entries.map((entry) => entry.path),
    ['song.mp3', 'Albums/track.flac', 'Albums/clip.bin', 'Albums/Sub/deep.ogg'],
  );
  assert.equal(entries[0].size, 2048);
  assert.equal(entries[0].mtime, Date.parse('2024-01-02T03:04:05.000Z'));
  assert.deepEqual(entries[0].externalIds, { gdrive: 'song' });
  assert.deepEqual(entries[3].externalIds, { gdrive: 'deep' });
  assert.equal(entries[1].size, 1024);

  const expectedMap = {
    'song.mp3': 'song',
    'Albums/track.flac': 'track',
    'Albums/clip.bin': 'clip',
    'Albums/Sub/deep.ogg': 'deep',
  };
  assert.deepEqual(meta.map.get('gdriveItems'), expectedMap);
  assert.ok(requests.every((request) => request.fields === FILE_FIELDS));
  assert.ok(requests.every((request) => request.q.includes('trashed = false')));
});

test('browse on 401 drops the token and flips the permission to prompt', async () => {
  const meta = memoryMeta({
    gdriveToken: validToken(),
    gdriveRoot: { id: 'rootid', path: '', name: 'Music' },
  });
  const fetchImpl = async () =>
    jsonResponse(401, { error: { code: 401, message: 'Invalid Credentials' } });
  const source = makeSource({ meta, fetchImpl });
  await source.restore();
  assert.equal(source.permission(), 'granted');

  await assert.rejects(
    source.browse(),
    (error) => error instanceof GdriveError && error.status === 401,
  );

  assert.equal(source.permission(), 'prompt');
  assert.equal(meta.map.get('gdriveToken'), null);
});

test('scan on 401 drops the token and persists the aborted item map', async () => {
  const meta = memoryMeta({
    gdriveToken: validToken(),
    gdriveRoot: { id: 'rootid', path: '', name: 'Music' },
  });
  const fetchImpl = async () =>
    jsonResponse(401, { error: { code: 401, message: 'Invalid Credentials' } });
  const source = makeSource({ meta, fetchImpl });
  await source.restore();

  await assert.rejects(
    async () => {
      for await (const entry of source.scan()) void entry;
    },
    (error) => error instanceof GdriveError && error.status === 401,
  );

  assert.equal(source.permission(), 'prompt');
  assert.equal(meta.map.get('gdriveToken'), null);
  assert.deepEqual(meta.map.get('gdriveItems'), {});
});

test('an unconfigured source fails all entry points without any network call', async () => {
  let fetches = 0;
  let gisCalls = 0;
  const source = makeSource({
    meta: memoryMeta(),
    clientId: '',
    fetchImpl: async () => {
      fetches += 1;
      throw new Error('no network expected');
    },
    getGis: async () => {
      gisCalls += 1;
      throw new Error('gis must not load');
    },
  });

  assert.equal(source.configured(), false);
  await assert.rejects(
    source.connect(),
    (error) => error instanceof GdriveAuthError && error.code === 'not_configured',
  );
  await assert.rejects(
    source.browse(),
    (error) => error instanceof GdriveError && error.code === 'authRequired',
  );
  await assert.rejects(
    async () => {
      for await (const entry of source.scan()) void entry;
    },
    (error) => error instanceof GdriveError && error.code === 'authRequired',
  );
  await assert.rejects(
    source.getFile('song.mp3'),
    (error) => error instanceof GdriveError && error.code === 'authRequired',
  );

  assert.equal(gisCalls, 0);
  assert.equal(fetches, 0);
});

test('getFile serves a cached blob before authorization even with an expired token', async () => {
  const cached = new Blob([new Uint8Array([1, 2, 3])]);
  const reads = [];
  const cache = {
    async read(key) {
      reads.push(key);
      return cached;
    },
    async write() {
      throw new Error('write not expected on a hit');
    },
  };
  let fetches = 0;
  const source = makeSource({
    meta: memoryMeta({
      gdriveToken: { accessToken: 'old', expiresAt: 1, scope: '' },
      gdriveRoot: { id: 'rootid', path: '', name: 'Music' },
    }),
    cache,
    fetchImpl: async () => {
      fetches += 1;
      throw new Error('no network expected');
    },
  });
  await source.restore();
  assert.equal(source.permission(), 'prompt');

  const blob = await source.getFile('song.mp3');

  assert.equal(blob, cached);
  assert.deepEqual(reads, ['gdrive:song.mp3']);
  assert.equal(fetches, 0);
});

test('getFile resolves by name, downloads with Bearer and fills the cache', async () => {
  const audio = new Uint8Array([0x49, 0x44, 0x33]);
  const calls = [];
  const writes = [];
  const cache = {
    async read() {
      return null;
    },
    async write(entry) {
      writes.push(entry);
    },
  };
  const fetchImpl = async (url, init = {}) => {
    const request = driveRequest(url);
    calls.push({ ...request, headers: init.headers ?? {} });
    if (request.path === '/drive/v3/files') {
      assert.equal(request.q, "'root' in parents and name = 'song.mp3' and trashed = false");
      return jsonResponse(200, {
        files: [{ id: 'song-id', name: 'song.mp3', mimeType: 'audio/mpeg' }],
      });
    }
    if (request.path === '/drive/v3/files/song-id' && request.alt === 'media') {
      return bytesResponse(200, audio);
    }
    throw new Error(`unexpected request: ${url}`);
  };
  const source = makeSource({
    meta: memoryMeta({
      gdriveToken: validToken(),
      gdriveRoot: { id: 'rootid', path: '', name: 'Music' },
    }),
    cache,
    fetchImpl,
  });
  await source.restore();

  const blob = await source.getFile('song.mp3', { awaitCache: true });

  assert.deepEqual(Array.from(new Uint8Array(await blob.arrayBuffer())), [0x49, 0x44, 0x33]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.Authorization, 'Bearer access');
  assert.equal(calls[1].headers.Authorization, 'Bearer access');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].key, 'gdrive:song.mp3');
  assert.equal(writes[0].source, 'gdrive');
  assert.equal(writes[0].path, 'song.mp3');
  assert.equal(writes[0].blob.size, 3);
  assert.deepEqual(Array.from(new Uint8Array(await writes[0].blob.arrayBuffer())), [0x49, 0x44, 0x33]);
});

test('tag reads still work when the server answers any Range with the whole 200 body', async () => {
  const TOTAL = 33 * 1024 * 1024;
  const body = new Uint8Array(TOTAL);
  body.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const request = driveRequest(url);
    calls.push({ ...request, headers: init.headers ?? {} });
    if (request.path === '/drive/v3/files') {
      return jsonResponse(200, {
        files: [
          {
            id: 'big',
            name: 'big.mp3',
            mimeType: 'audio/mpeg',
            size: String(TOTAL),
            modifiedTime: '2024-05-06T07:08:09Z',
          },
        ],
      });
    }
    if (request.alt === 'media') {
      return {
        status: 200,
        ok: true,
        async arrayBuffer() {
          return body.buffer;
        },
        async json() {
          return null;
        },
      };
    }
    throw new Error(`unexpected request: ${url}`);
  };
  const source = makeSource({
    meta: memoryMeta({
      gdriveToken: validToken(),
      gdriveRoot: { id: 'bigroot', path: '', name: 'Big' },
    }),
    fetchImpl,
  });
  await source.restore();

  const entries = [];
  for await (const entry of source.scan()) entries.push(entry);
  assert.equal(entries.length, 1);

  const file = await entries[0].readFile();
  const buffer = await file.slice(0, 4).arrayBuffer();

  assert.deepEqual(Array.from(new Uint8Array(buffer)), [0x52, 0x49, 0x46, 0x46]);
  const media = calls.find((call) => call.alt === 'media');
  assert.ok(media.headers.Range.startsWith('bytes=0-'));
});
