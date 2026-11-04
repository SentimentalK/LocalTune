import test from 'node:test';
import assert from 'node:assert/strict';

import { Prefetcher } from '../src/core/prefetch.js';

function harness({ fail = false } = {}) {
  const revoked = [];
  const created = [];
  const prefetcher = new Prefetcher({
    load: async (track) => {
      if (fail) throw new Error('read failed');
      return { id: track.id };
    },
    createUrl: (blob) => {
      const url = `blob:${blob.id}`;
      created.push(url);
      return url;
    },
    revokeUrl: (url) => revoked.push(url),
  });
  return { prefetcher, revoked, created };
}

test('prime reaches ready and take hands the URL to the caller', async () => {
  const { prefetcher, revoked, created } = harness();

  const primed = await prefetcher.prime({ id: 'a' });
  assert.deepEqual(primed, { id: 'a', url: 'blob:a' });
  assert.deepEqual(prefetcher.state, { status: 'ready', id: 'a', url: 'blob:a' });

  assert.equal(prefetcher.take('b'), null);
  assert.equal(prefetcher.state.status, 'ready', 'a miss keeps the slot');
  assert.deepEqual(prefetcher.state, { status: 'ready', id: 'a', url: 'blob:a' });

  assert.deepEqual(prefetcher.take('a'), { id: 'a', url: 'blob:a' });
  assert.deepEqual(prefetcher.state, { status: 'taken', id: null, url: null });
  assert.deepEqual(created, ['blob:a']);
  assert.deepEqual(revoked, [], 'ownership moved to the caller');
});

test('priming a different id revokes the previous URL', async () => {
  const { prefetcher, revoked } = harness();

  await prefetcher.prime({ id: 'a' });
  const next = await prefetcher.prime({ id: 'b' });
  assert.deepEqual(next, { id: 'b', url: 'blob:b' });
  assert.deepEqual(revoked, ['blob:a']);
  assert.deepEqual(prefetcher.state, { status: 'ready', id: 'b', url: 'blob:b' });
});

test('concurrent primes keep only the newest result', async () => {
  const revoked = [];
  const pending = new Map();
  const prefetcher = new Prefetcher({
    load: (track) =>
      new Promise((resolve) => {
        pending.set(track.id, () => resolve({ id: track.id }));
      }),
    createUrl: (blob) => `blob:${blob.id}`,
    revokeUrl: (url) => revoked.push(url),
  });

  const first = prefetcher.prime({ id: 'a' });
  const second = prefetcher.prime({ id: 'b' });
  pending.get('b')();
  assert.deepEqual(await second, { id: 'b', url: 'blob:b' });

  pending.get('a')();
  assert.equal(await first, null);
  assert.deepEqual(revoked, ['blob:a']);
  assert.deepEqual(prefetcher.state, { status: 'ready', id: 'b', url: 'blob:b' });
});

test('a failed load returns null and resets to idle', async () => {
  const { prefetcher } = harness({ fail: true });
  assert.equal(await prefetcher.prime({ id: 'a' }), null);
  assert.deepEqual(prefetcher.state, { status: 'idle', id: null, url: null });
});

test('priming without a track clears the slot', async () => {
  const { prefetcher, revoked } = harness();
  await prefetcher.prime({ id: 'a' });
  assert.equal(await prefetcher.prime(null), null);
  assert.equal(prefetcher.state.status, 'cleared');
  assert.deepEqual(revoked, ['blob:a']);
});

test('clear revokes an untaken URL', async () => {
  const { prefetcher, revoked } = harness();
  await prefetcher.prime({ id: 'a' });
  prefetcher.clear();
  assert.deepEqual(revoked, ['blob:a']);
  assert.deepEqual(prefetcher.state, { status: 'cleared', id: null, url: null });
});
