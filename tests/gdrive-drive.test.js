import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FOLDER_FIELDS,
  FOLDER_MIME,
  GdriveError,
  allChildrenQuery,
  createDriveClient,
  escapeQueryValue,
  folderChildrenQuery,
  namedFolderQuery,
} from '../src/core/sources/googledrive/drive.js';

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

function recordingFetch(responses) {
  const calls = [];
  const queue = [...responses];
  return {
    calls,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method, headers: init.headers ?? {} });
      const next = queue.shift();
      if (!next) throw new Error(`unexpected fetch: ${url}`);
      return next;
    },
  };
}

test('list follows nextPageToken and sends the query, fields and paging on every page', async () => {
  const { calls, fetchImpl } = recordingFetch([
    jsonResponse(200, {
      files: [{ id: '1', name: 'A', mimeType: FOLDER_MIME }],
      nextPageToken: 'page-2',
    }),
    jsonResponse(200, { files: [{ id: '2', name: 'B', mimeType: FOLDER_MIME }] }),
  ]);
  const client = createDriveClient({
    fetchImpl,
    getToken: () => 'tok',
    baseUrl: 'https://drive.test/v3',
  });

  const files = [];
  for await (const page of client.list({
    q: "'root' in parents and trashed = false",
    fields: FOLDER_FIELDS,
    pageSize: 2,
    orderBy: 'name',
  })) {
    files.push(...page);
  }

  assert.deepEqual(
    files.map((item) => item.id),
    ['1', '2'],
  );
  assert.equal(calls.length, 2);

  const first = new URL(calls[0].url);
  assert.equal(`${first.origin}${first.pathname}`, 'https://drive.test/v3/files');
  assert.equal(first.searchParams.get('q'), "'root' in parents and trashed = false");
  assert.equal(first.searchParams.get('fields'), FOLDER_FIELDS);
  assert.equal(first.searchParams.get('pageSize'), '2');
  assert.equal(first.searchParams.get('orderBy'), 'name');
  assert.equal(first.searchParams.get('pageToken'), null);
  assert.equal(calls[0].headers.Authorization, 'Bearer tok');
  assert.equal(calls[0].headers.Accept, 'application/json');

  const second = new URL(calls[1].url);
  assert.equal(second.searchParams.get('pageToken'), 'page-2');
  assert.equal(second.searchParams.get('q'), "'root' in parents and trashed = false");
  assert.equal(second.searchParams.get('orderBy'), 'name');
});

test('a 401 listing response throws GdriveError with status 401', async () => {
  const { fetchImpl } = recordingFetch([
    jsonResponse(401, { error: { code: 401, message: 'Invalid Credentials' } }),
  ]);
  const client = createDriveClient({
    fetchImpl,
    getToken: () => 'expired',
    baseUrl: 'https://drive.test/v3',
  });

  await assert.rejects(
    client.listFiles({ q: allChildrenQuery('root') }),
    (error) =>
      error instanceof GdriveError &&
      error.status === 401 &&
      error.code === 401 &&
      error.name === 'GdriveError',
  );
});

test('escapeQueryValue escapes backslashes before quotes', () => {
  assert.equal(escapeQueryValue("O'Brien\\Music"), "O\\'Brien\\\\Music");
  assert.equal(escapeQueryValue(undefined), '');
  assert.equal(escapeQueryValue("a'b\\c"), "a\\'b\\\\c");
});

test('query builders emit parent, name and trash clauses', () => {
  const folders = folderChildrenQuery('folder-1');
  assert.ok(folders.startsWith("'folder-1' in parents"));
  assert.ok(folders.includes(`mimeType = '${FOLDER_MIME}'`));
  assert.ok(folders.endsWith('trashed = false'));

  const named = namedFolderQuery('parent-1', "O'Brien");
  assert.ok(named.startsWith("'parent-1' in parents"));
  assert.ok(named.includes("name = 'O\\'Brien'"));
  assert.ok(named.includes(`mimeType = '${FOLDER_MIME}'`));
  assert.ok(named.endsWith('trashed = false'));

  const children = allChildrenQuery('parent-2');
  assert.equal(children, "'parent-2' in parents and trashed = false");
  assert.ok(!children.includes('mimeType'));
});

test('fetchMedia sends a byte Range and reports the response status', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const { calls, fetchImpl } = recordingFetch([bytesResponse(206, bytes)]);
  const client = createDriveClient({
    fetchImpl,
    getToken: () => 'tok',
    baseUrl: 'https://drive.test/v3',
  });

  const result = await client.fetchMedia('id with space', { range: { start: 0, end: 3 } });

  assert.equal(result.status, 206);
  assert.deepEqual(Array.from(result.bytes), [1, 2, 3, 4]);
  assert.equal(calls[0].url, 'https://drive.test/v3/files/id%20with%20space?alt=media');
  assert.equal(calls[0].headers.Range, 'bytes=0-3');
  assert.equal(calls[0].headers.Authorization, 'Bearer tok');
});

test('fetchMedia without a range sends no Range header', async () => {
  const { calls, fetchImpl } = recordingFetch([bytesResponse(200, new Uint8Array([9]))]);
  const client = createDriveClient({
    fetchImpl,
    getToken: () => 'tok',
    baseUrl: 'https://drive.test/v3',
  });

  const result = await client.fetchMedia('id-1');

  assert.equal(result.status, 200);
  assert.deepEqual(Array.from(result.bytes), [9]);
  assert.equal(Object.hasOwn(calls[0].headers, 'Range'), false);
});
