import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthorSource } from '../src/core/sources/author/source.js';
import { cacheKey } from '../src/core/cache/audioCache.js';
import { AUTHOR_TRACKS } from '../src/author/playlist.js';

function fakeCache() {
  const blobs = new Map();
  return {
    writes: [],
    async read(key) {
      return blobs.get(key) ?? null;
    },
    async write(row) {
      this.writes.push(row);
      blobs.set(row.key, row.blob);
    },
  };
}

function responseFor(body, status = 200) {
  return new Response(new Blob([body], { type: 'audio/mpeg' }), { status });
}

test('getFile fetches once and reuses the cached blob', async () => {
  const cache = fakeCache();
  let calls = 0;
  const source = new AuthorSource({
    cache,
    baseUrl: 'http://localhost/',
    fetchImpl: async (url) => {
      calls += 1;
      assert.equal(url.href, 'http://localhost/author/libai.mp3');
      return responseFor('audio-bytes');
    },
  });

  const first = await source.getFile('libai.mp3');
  assert.equal(await first.text(), 'audio-bytes');
  assert.equal(calls, 1);
  assert.equal(cache.writes.length, 1);
  assert.equal(cache.writes[0].key, cacheKey('author', 'libai.mp3'));
  assert.equal(cache.writes[0].source, 'author');

  const second = await source.getFile('libai.mp3');
  assert.equal(await second.text(), 'audio-bytes');
  assert.equal(calls, 1, 'the second read comes from the cache');
});

test('concurrent reads share one network request', async () => {
  const cache = fakeCache();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const source = new AuthorSource({
    cache,
    baseUrl: 'http://localhost/',
    fetchImpl: async () => {
      calls += 1;
      await gate;
      return responseFor('audio-bytes');
    },
  });

  const one = source.getFile('jieyan.mp3');
  const two = source.getFile('jieyan.mp3');
  release();
  const [a, b] = await Promise.all([one, two]);
  assert.equal(await a.text(), 'audio-bytes');
  assert.equal(await b.text(), 'audio-bytes');
  assert.equal(calls, 1);
});

test('getFile surfaces a failed response', async () => {
  const source = new AuthorSource({
    cache: fakeCache(),
    baseUrl: 'http://localhost/',
    fetchImpl: async () => responseFor('', 404),
  });

  await assert.rejects(() => source.getFile('missing.mp3'), /404/);
});

test('warm skips the playing track and non-author entries', async () => {
  const cache = fakeCache();
  const fetched = [];
  const source = new AuthorSource({
    cache,
    baseUrl: 'http://localhost/',
    fetchImpl: async (url) => {
      fetched.push(url.pathname);
      return responseFor('audio-bytes');
    },
  });

  const tracks = [
    { id: 'author:a', source: 'author', path: 'a.mp3' },
    { id: 'author:b', source: 'author', path: 'b.mp3' },
    { id: 'demo:x', source: 'demo', path: 'x.mp3' },
  ];
  await source.warm(tracks, 'author:a');

  assert.deepEqual(fetched, ['/author/b.mp3']);
});

test('the manifest is self-consistent', () => {
  assert.equal(AUTHOR_TRACKS.length, 6);
  assert.deepEqual(
    AUTHOR_TRACKS.map((track) => track.id),
    [
      'author:qingfeideyi',
      'author:pugongying-de-yueding',
      'author:libai',
      'author:putong-pengyou',
      'author:jiushi-aini',
      'author:yichang-youxi-yichang-meng',
    ],
  );
  const ids = new Set();
  for (const track of AUTHOR_TRACKS) {
    assert.equal(track.source, 'author');
    assert.match(track.id, /^author:[a-z0-9-]+$/);
    assert.match(track.path, /^[a-z0-9-]+\.mp3$/);
    assert.ok(track.duration > 0);
    assert.ok(track.size > 0);
    assert.equal(track.hasCover, true);
    assert.match(track.coverSrc, /^\.\/author\/covers\/[a-z0-9-]+\.webp$/);
    assert.match(track.coverThumb, /^\.\/author\/covers\/[a-z0-9-]+-96\.webp$/);
    assert.ok(!ids.has(track.id), `duplicate id ${track.id}`);
    ids.add(track.id);
  }
});
