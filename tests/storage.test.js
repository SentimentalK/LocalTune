import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatBytes,
  estimateLibrary,
  estimateAudioCache,
  clearAudioCache,
} from '../src/core/storage.js';

function response(size, type = null) {
  const headers = type ? { 'content-type': type } : {};
  return new Response(new Blob([new Uint8Array(size)]), { headers });
}

/** Minimal Cache Storage double: one cache with url → {size,type} entries. */
function fakeCaches(rows, { name = 'localtune-audio', broken = [] } = {}) {
  const entries = new Map(rows.map((row) => [row.url, row]));
  const failures = new Set(broken);
  const cache = {
    async keys() {
      return [...entries.keys()];
    },
    async match(request) {
      if (failures.has(String(request))) throw new Error('unreadable');
      const row = entries.get(String(request));
      if (!row) return undefined;
      return response(row.size, row.type ?? null);
    },
    async delete(request) {
      return entries.delete(String(request));
    },
  };
  return {
    async keys() {
      return [name];
    },
    async open() {
      return cache;
    },
    remaining() {
      return [...entries.keys()];
    },
  };
}

test('formatBytes handles the byte and binary-unit boundaries', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1), '1 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1024 * 1024), '1 MB');
});

test('estimateLibrary counts records without covers and sums stored cover sizes', () => {
  const withCover = {
    id: 'fsa:a.mp3',
    path: 'a.mp3',
    title: 'A',
    hasCover: true,
    coverSize: 1234,
  };
  const withoutCover = {
    id: 'fsa:b.mp3',
    path: 'b.mp3',
    title: 'B',
    hasCover: false,
    coverSize: 0,
  };

  const expected = new TextEncoder().encode(
    JSON.stringify({
      id: 'fsa:a.mp3',
      path: 'a.mp3',
      title: 'A',
      hasCover: true,
      coverSize: 1234,
    }),
  ).length +
    new TextEncoder().encode(
      JSON.stringify({
        id: 'fsa:b.mp3',
        path: 'b.mp3',
        title: 'B',
        hasCover: false,
        coverSize: 0,
      }),
    ).length;

  return estimateLibrary([withCover, withoutCover]).then((estimate) => {
    assert.equal(estimate.indexBytes, expected);
    assert.equal(estimate.coverBytes, 1234);
  });
});

test('estimateAudioCache finds audio by extension and by content type', async () => {
  const caches = fakeCaches([
    { url: 'https://app.test/music/song.mp3', size: 2048 },
    { url: 'https://app.test/music/cover.jpg', size: 500 },
    { url: 'https://app.test/music/stream', size: 1024, type: 'audio/mpeg' },
    { url: 'https://app.test/music/notes.txt', size: 12, type: 'text/plain' },
  ]);

  assert.equal(await estimateAudioCache(caches), 2048 + 1024);
});

test('estimateAudioCache skips unreadable entries', async () => {
  const caches = fakeCaches(
    [
      { url: 'https://app.test/broken.mp3', size: 10 },
      { url: 'https://app.test/good.mp3', size: 64 },
    ],
    { broken: ['https://app.test/broken.mp3'] },
  );

  assert.equal(await estimateAudioCache(caches), 64);
});

test('clearAudioCache deletes only audio entries and returns their bytes', async () => {
  const caches = fakeCaches([
    { url: 'https://app.test/music/song.mp3', size: 2048 },
    { url: 'https://app.test/music/cover.jpg', size: 500 },
    { url: 'https://app.test/music/stream', size: 1024, type: 'audio/flac' },
  ]);

  assert.equal(await clearAudioCache(caches), 2048 + 1024);
  assert.deepEqual(caches.remaining(), ['https://app.test/music/cover.jpg']);
});

test('same-origin filtering ignores cross-origin audio entries', async () => {
  const previous = globalThis.location;
  globalThis.location = { href: 'https://app.test/', origin: 'https://app.test' };
  try {
    const caches = fakeCaches([
      { url: 'https://app.test/local.mp3', size: 100 },
      { url: 'https://cdn.example/remote.mp3', size: 900 },
    ]);
    assert.equal(await estimateAudioCache(caches), 100);
  } finally {
    if (previous === undefined) delete globalThis.location;
    else globalThis.location = previous;
  }
});
