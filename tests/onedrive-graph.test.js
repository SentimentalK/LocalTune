import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GraphError,
  audioEntries,
  createGraphClient,
  itemPath,
  relativeToRoot,
} from '../src/core/sources/onedrive/graph.js';

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return body;
    },
  };
}

function graphClient(handler, token = 'token') {
  const calls = [];
  const client = createGraphClient({
    fetchImpl: async (url, init) => {
      calls.push([url, init]);
      return handler(url, init, calls.length - 1);
    },
    getToken: async () => token,
  });
  return { client, calls };
}

test('listChildren merges pages across @odata.nextLink', async () => {
  const nextLink = 'https://graph.microsoft.com/v1.0/next';
  const { client, calls } = graphClient((url) => {
    if (url === nextLink) {
      return jsonResponse(200, { value: [{ id: 'c' }] });
    }
    return jsonResponse(200, {
      value: [{ id: 'a' }, { id: 'b' }],
      '@odata.nextLink': nextLink,
    });
  });

  const seen = [];
  for await (const item of client.listChildren('drive1', 'root')) {
    seen.push(item.id);
  }

  assert.deepEqual(seen, ['a', 'b', 'c']);
  assert.equal(calls.length, 2);
  assert.equal(calls[1][0], nextLink);
  assert.equal(calls[1][1].headers.Authorization, 'Bearer token');
  assert.equal(calls[1][1].headers.Accept, 'application/json');
});

test('listChildren first request carries $top and $select', async () => {
  const { client, calls } = graphClient(() => jsonResponse(200, { value: [] }));

  for await (const item of client.listChildren('drive1', 'item1')) {
    assert.fail(`unexpected item ${item.id}`);
  }

  assert.equal(calls.length, 1);
  const url = calls[0][0];
  assert.ok(url.includes('/drives/drive1/items/item1/children'));
  assert.ok(url.includes('$top=200'));
  assert.ok(url.includes('$select='));
});

test('getJson throws GraphError with status and code on 401', async () => {
  const { client } = graphClient(() =>
    jsonResponse(401, {
      error: { code: 'InvalidAuthenticationToken', message: 'token expired' },
    }),
  );

  await assert.rejects(client.getJson('/me/drive'), (error) => {
    assert.ok(error instanceof GraphError);
    assert.equal(error.status, 401);
    assert.equal(error.code, 'InvalidAuthenticationToken');
    assert.equal(error.message, 'token expired');
    return true;
  });
});

test('getJson joins paths onto baseUrl and passes absolute URLs through', async () => {
  const { client, calls } = graphClient(() => jsonResponse(200, { ok: true }));

  await client.getJson('/me/drive');
  await client.getJson('https://graph.microsoft.com/v1.0/other');

  assert.equal(calls[0][0], 'https://graph.microsoft.com/v1.0/me/drive');
  assert.equal(calls[1][0], 'https://graph.microsoft.com/v1.0/other');
});

test('getDownloadUrl returns the annotation and rejects items without one', async () => {
  const download = 'https://download.example/file';
  const { client, calls } = graphClient(() =>
    jsonResponse(200, { id: 'i', '@microsoft.graph.downloadUrl': download }),
  );

  assert.equal(await client.getDownloadUrl('drive1', 'item1'), download);
  assert.match(calls[0][0], /\$select=/);
  assert.match(calls[0][0], /%40microsoft\.graph\.downloadUrl/);

  const { client: bare } = graphClient(() => jsonResponse(200, { id: 'i' }));
  await assert.rejects(bare.getDownloadUrl('drive1', 'item1'), (error) => {
    assert.ok(error instanceof GraphError);
    assert.equal(error.code, 'noDownloadUrl');
    return true;
  });
});

test('fetchRange requests bytes without Authorization and returns them', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const calls = [];
  const client = createGraphClient({
    fetchImpl: async (url, init) => {
      calls.push([url, init]);
      return {
        status: 206,
        ok: true,
        async arrayBuffer() {
          return bytes.buffer;
        },
      };
    },
    getToken: async () => 'should-not-be-used',
  });

  const result = await client.fetchRange('https://download.example/file', 0, 1023);

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://download.example/file');
  assert.equal(calls[0][1].headers.Range, 'bytes=0-1023');
  assert.equal(calls[0][1].headers.Authorization, undefined);
  assert.deepEqual(result.bytes, bytes);
  assert.equal(result.status, 206);
});

test('fetchRange throws GraphError on a non-success status', async () => {
  const client = createGraphClient({
    fetchImpl: async () => ({ status: 416, ok: false }),
    getToken: async () => 'token',
  });

  await assert.rejects(client.fetchRange('https://download.example/file', 0, 10), (error) => {
    assert.ok(error instanceof GraphError);
    assert.equal(error.status, 416);
    return true;
  });
});

test('audioEntries keeps audio files by lowercase extension', () => {
  const items = [
    { name: 'song.mp3', file: { mimeType: 'audio/mpeg' } },
    { name: 'Folder', folder: { childCount: 2 } },
    { name: 'notes.txt', file: { mimeType: 'text/plain' } },
    { name: 'LOUD.MP3', file: { mimeType: 'audio/mpeg' } },
    { name: 'track.FlAc', file: { mimeType: 'audio/flac' } },
    { name: 'noext', file: { mimeType: 'audio/mpeg' } },
  ];

  assert.deepEqual(
    audioEntries(items).map((item) => item.name),
    ['song.mp3', 'LOUD.MP3', 'track.FlAc'],
  );
});

test('itemPath joins POSIX paths without stray slashes', () => {
  assert.equal(itemPath('Music', 'a.mp3'), 'Music/a.mp3');
  assert.equal(itemPath('', 'a.mp3'), 'a.mp3');
  assert.equal(itemPath('/Music/', '/a.mp3'), 'Music/a.mp3');
  assert.equal(itemPath('Music/', 'Sub/a.mp3'), 'Music/Sub/a.mp3');
  assert.equal(itemPath('', ''), '');
});

test('relativeToRoot strips a known root and rejects foreign paths', () => {
  assert.equal(relativeToRoot('Music', 'Music/a/b.mp3'), 'a/b.mp3');
  assert.equal(relativeToRoot('Music', 'Music'), '');
  assert.equal(relativeToRoot('', '/a.mp3'), 'a.mp3');
  assert.equal(relativeToRoot('/Music/', '/Music/a.mp3'), 'a.mp3');
  assert.throws(() => relativeToRoot('Music', 'Movies/a.mp3'), /outside root/);
  assert.throws(() => relativeToRoot('Music', 'Musical/a.mp3'), /outside root/);
});
