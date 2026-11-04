import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryCache } from '../src/memory-cache.js';

function response(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('memory cache returns status, body and headers and can be read twice', async () => {
  const cache = createMemoryCache();
  await cache.put('k', response({ hello: 'world' }, { headers: { 'cache-control': 'max-age=600' } }));

  const first = await cache.match('k');
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-type'), 'application/json');
  assert.equal(first.headers.get('cache-control'), 'max-age=600');
  assert.deepEqual(await first.json(), { hello: 'world' });

  const second = await cache.match('k');
  assert.deepEqual(await second.json(), { hello: 'world' });
});

test('memory cache expires entries after the ttl', async () => {
  let clock = 1_000;
  const cache = createMemoryCache({ ttlMs: 500, now: () => clock });
  await cache.put('k', response({ ok: true }));
  assert.equal(cache.size, 1);

  clock += 499;
  assert.deepEqual(await (await cache.match('k')).json(), { ok: true });

  clock += 1;
  assert.equal(await cache.match('k'), undefined);
  assert.equal(cache.size, 0);
});

test('memory cache evicts the least recently used entry beyond maxEntries', async () => {
  const cache = createMemoryCache({ maxEntries: 3 });
  await cache.put('a', response({ key: 'a' }));
  await cache.put('b', response({ key: 'b' }));
  await cache.put('c', response({ key: 'c' }));
  await cache.put('d', response({ key: 'd' }));

  assert.equal(cache.size, 3);
  assert.equal(await cache.match('a'), undefined);
  assert.deepEqual(await (await cache.match('b')).json(), { key: 'b' });
  assert.deepEqual(await (await cache.match('c')).json(), { key: 'c' });
  assert.deepEqual(await (await cache.match('d')).json(), { key: 'd' });
  assert.equal(cache.size, 3);
});
