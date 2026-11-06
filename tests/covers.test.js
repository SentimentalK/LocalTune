import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCoverCache } from '../src/core/coverCache.js';
import { carryCover } from '../src/core/store.js';

/** Blob factory with stable bytes; load() counts calls per id. */
function harness({ limit = 64, blobs = null } = {}) {
  const loads = new Map();
  const created = [];
  const revoked = [];
  let urls = 0;
  const cache = createCoverCache({
    load: async (id) => {
      loads.set(id, (loads.get(id) ?? 0) + 1);
      if (blobs instanceof Error) throw blobs;
      if (blobs && blobs[id] === undefined) throw new Error(`no cover ${id}`);
      return blobs ? blobs[id] : new Blob([`cover:${id}`], { type: 'image/png' });
    },
    createUrl: (blob) => {
      const url = `blob:cover-${++urls}`;
      created.push({ url, blob });
      return url;
    },
    revokeUrl: (url) => revoked.push(url),
    limit,
  });
  return { cache, loads, created, revoked };
}

test('concurrent acquires for one id share a single load and object URL', async () => {
  const { cache, loads, created } = harness();

  const [first, second] = await Promise.all([cache.acquire('a'), cache.acquire('a')]);

  assert.equal(first, 'blob:cover-1');
  assert.equal(second, first);
  assert.equal(loads.get('a'), 1);
  assert.equal(created.length, 1);
  assert.equal(cache.size, 1);
  assert.equal(cache.has('a'), true);
});

test('releasing to zero over the limit revokes the least recently used URL', async () => {
  const { cache, revoked } = harness({ limit: 2 });

  const a = await cache.acquire('a');
  cache.release('a');
  const b = await cache.acquire('b');
  cache.release('b');
  await cache.acquire('c');

  assert.equal(cache.size, 2);
  assert.equal(cache.has('a'), false);
  assert.equal(cache.has('b'), true);
  assert.equal(cache.has('c'), true);
  assert.deepEqual(revoked, [a]);
  assert.ok(b);
});

test('a release that crosses the limit evicts immediately', async () => {
  const { cache, revoked } = harness({ limit: 2 });

  const a = await cache.acquire('a');
  const b = await cache.acquire('b');
  await cache.acquire('c');
  assert.equal(cache.size, 3);

  cache.release('b');

  assert.equal(cache.has('b'), false);
  assert.equal(cache.size, 2);
  assert.deepEqual(revoked, [b]);
  assert.ok(a);
});

test('retain drops excluded entries once their last reference is released', async () => {
  const { cache, revoked } = harness();

  const a = await cache.acquire('a');
  assert.equal(revoked.length, 0);

  cache.retain([]);
  assert.equal(cache.has('a'), true, 'a held reference is never revoked mid-use');

  cache.release('a');
  assert.equal(cache.has('a'), false);
  assert.deepEqual(revoked, [a]);

  const b = await cache.acquire('b');
  cache.retain(['b']);
  cache.release('b');
  assert.equal(cache.has('b'), true, 'retained ids survive release to zero');
  assert.ok(b);
});

test('a failing or non-Blob load resolves null without caching or creating a URL', async () => {
  const failing = harness({ blobs: new Error('corrupt') });
  assert.equal(await failing.cache.acquire('broken'), null);
  assert.equal(failing.cache.size, 0);
  assert.equal(failing.created.length, 0);
  assert.equal(await failing.cache.acquire('broken'), null);
  assert.equal(failing.loads.get('broken'), 2, 'failures are not cached');

  const nonBlob = createCoverCache({
    load: async () => ({ not: 'a blob' }),
    createUrl: () => {
      throw new Error('must not create a URL');
    },
  });
  assert.equal(await nonBlob.acquire('x'), null);
  assert.equal(nonBlob.size, 0);
});

test('clear revokes every live URL and drops in-flight results', async () => {
  const { cache, revoked } = harness();
  const a = await cache.acquire('a');
  const pending = cache.acquire('b');

  cache.clear();
  assert.equal(cache.size, 0);
  assert.deepEqual(revoked, [a]);
  assert.equal(await pending, null);
  assert.equal(cache.has('b'), false);
});

test('carryCover keeps stored artwork without writing cover:null', () => {
  const previous = { hasCover: true, coverSize: 777, coverType: 'image/png' };

  // buildTrack without an embedded picture must not produce cover:null:
  // putTracks treats that as an explicit erase.
  const track = { id: 'fsa:a.mp3', hasCover: false, coverSize: 0, coverType: null };
  carryCover(track, previous);

  assert.equal(Object.prototype.hasOwnProperty.call(track, 'cover'), false);
  assert.equal(track.hasCover, true);
  assert.equal(track.coverSize, 777);
  assert.equal(track.coverType, 'image/png');

  // A freshly read Blob is kept for the one write that moves it.
  const blob = new Blob(['jpeg'], { type: 'image/jpeg' });
  const fresh = { id: 'fsa:b.mp3', cover: blob, hasCover: true, coverSize: 4, coverType: 'image/jpeg' };
  carryCover(fresh, previous);
  assert.equal(fresh.cover, blob);
  assert.equal(fresh.hasCover, true);
  assert.equal(fresh.coverSize, 4);

  // Without a stored cover there is nothing to preserve and nothing to erase.
  const plain = { id: 'fsa:c.mp3', cover: null };
  carryCover(plain, { hasCover: false });
  assert.equal(plain.cover, null);
});
