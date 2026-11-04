import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AudioCache,
  AUDIO_CACHE_NAME,
  cacheKey,
  cacheRequest,
  isPinned,
  selectEvictions,
  totalSize,
} from '../src/core/cache/audioCache.js';
import {
  createCacheIndex,
  createPinStore,
  CACHE_INDEX_STORE,
  PINS_STORE,
} from '../src/core/cache/index.js';

function blob(size) {
  return new Blob([new Uint8Array(size)]);
}

/** In-memory Cache Storage double; each lookup returns a fresh Response. */
function memoryCaches({ failMatch = false } = {}) {
  const entries = new Map();

  const url = (request) => (typeof request === 'string' ? request : request.url);

  const cache = {
    async put(request, response) {
      entries.set(url(request), await response.blob());
    },
    async match(request) {
      if (failMatch) throw new Error('cache unavailable');
      const stored = entries.get(url(request));
      return stored ? new Response(stored) : undefined;
    },
    async delete(request) {
      return entries.delete(url(request));
    },
    async keys() {
      return [...entries.keys()].map((url) => new Request(url));
    },
  };

  return {
    entries,
    async open(name) {
      assert.equal(name, AUDIO_CACHE_NAME);
      return cache;
    },
    async keys() {
      return [AUDIO_CACHE_NAME];
    },
  };
}

function memoryIndex(rows = []) {
  const map = new Map(rows.map((row) => [row.key, { ...row }]));
  return {
    map,
    async all() {
      return [...map.values()].map((row) => ({ ...row }));
    },
    async put(row) {
      map.set(row.key, { ...row });
    },
    async deleteByKeys(keys) {
      for (const key of keys) map.delete(key);
    },
    async clear() {
      map.clear();
    },
  };
}

function memoryPins(rows = []) {
  const map = new Map(rows.map((row) => [row.id, { ...row }]));
  return {
    map,
    async all() {
      return [...map.values()].map((row) => ({ ...row }));
    },
    async put(pin) {
      map.set(pin.id, { ...pin });
    },
    async delete(id) {
      map.delete(id);
    },
  };
}

/** Minimal IndexedDB double exercising only `transaction(store, mode)`. */
function fakeDb() {
  const stores = new Map();

  function dataFor(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  }

  return {
    dataFor,
    transaction(name, mode) {
      const data = dataFor(name);
      const tx = {
        error: null,
        objectStore() {
          return {
            getAll() {
              const request = {};
              queueMicrotask(() => {
                request.result = [...data.values()].map((row) => ({ ...row }));
                request.onsuccess?.();
              });
              return request;
            },
            put(row) {
              data.set(row.key ?? row.id, { ...row });
            },
            delete(key) {
              data.delete(key);
            },
            clear() {
              data.clear();
            },
          };
        },
      };
      queueMicrotask(() => tx.oncomplete?.());
      return tx;
    },
  };
}

test('cacheKey strips leading slashes and stays stable across sources', () => {
  assert.equal(cacheKey('fsa', '/Jazz/a.mp3'), 'fsa:Jazz/a.mp3');
  assert.equal(cacheKey('fsa', '///Jazz/a.mp3'), 'fsa:Jazz/a.mp3');
  assert.equal(cacheKey('fsa', 'Jazz/a.mp3'), 'fsa:Jazz/a.mp3');
  assert.equal(cacheKey('opfs', 'Jazz/a.mp3'), 'opfs:Jazz/a.mp3');
  assert.notEqual(cacheKey('fsa', 'A/a.mp3'), cacheKey('fsa', 'B/a.mp3'));
});

test('cacheRequest builds a synthetic __audio URL without fetching', () => {
  const request = cacheRequest('fsa:Jazz/a.mp3');
  assert.ok(request instanceof Request);
  assert.match(request.url, /\/__audio\/fsa%3AJazz%2Fa\.mp3$/);
});

test('selectEvictions evicts the oldest entry until the limit fits', () => {
  const entries = [
    { key: 'b', size: 100, lastAccess: 30 },
    { key: 'a', size: 100, lastAccess: 10 },
    { key: 'c', size: 100, lastAccess: 20 },
  ];
  assert.deepEqual(selectEvictions(entries, 200), ['a']);
  assert.deepEqual(selectEvictions(entries, 100), ['a', 'c']);
  assert.deepEqual(selectEvictions(entries, 300), []);
});

test('selectEvictions treats zero or negative limits as unlimited', () => {
  const entries = [{ key: 'a', size: 100, lastAccess: 1 }];
  assert.deepEqual(selectEvictions(entries, 0), []);
  assert.deepEqual(selectEvictions(entries, -1), []);
});

test('selectEvictions never picks pinned entries', () => {
  const entries = [
    { key: 'a', source: 'fsa', path: 'Jazz/a.mp3', size: 100, lastAccess: 1 },
    { key: 'b', source: 'fsa', path: 'Rock/b.mp3', size: 100, lastAccess: 2 },
  ];
  const pins = [{ source: 'fsa', dir: 'Jazz' }];
  assert.deepEqual(selectEvictions(entries, 100, pins), ['b']);
  assert.deepEqual(selectEvictions(entries, 50, [{ source: 'fsa', dir: '' }]), []);
});

test('selectEvictions orders equal lastAccess by key', () => {
  const entries = [
    { key: 'z', size: 100, lastAccess: 5 },
    { key: 'a', size: 100, lastAccess: 5 },
    { key: 'm', size: 100, lastAccess: 5 },
  ];
  assert.deepEqual(selectEvictions(entries, 100), ['a', 'm']);
});

test('isPinned matches directories, roots and sources', () => {
  const pins = [{ source: 'fsa', dir: 'Jazz' }];
  assert.equal(isPinned({ source: 'fsa', path: 'Jazz/a.mp3' }, pins), true);
  assert.equal(isPinned({ source: 'fsa', path: 'Jazz' }, pins), true);
  assert.equal(isPinned({ source: 'fsa', path: 'Jazz2/a.mp3' }, pins), false);
  assert.equal(isPinned({ source: 'ops', path: 'Jazz/a.mp3' }, pins), false);
  assert.equal(isPinned({ source: 'ops', path: 'anything/a.mp3' }, [{ source: 'ops', dir: '' }]), true);
  assert.equal(isPinned({ source: 'ops', path: 'anything/a.mp3' }, []), false);
});

test('totalSize sums only finite sizes', () => {
  assert.equal(totalSize([{ size: 10 }, { size: 5 }, { size: null }]), 15);
  assert.equal(totalSize([]), 0);
});

test('AudioCache write and read round-trip through the index', async () => {
  const caches = memoryCaches();
  const index = memoryIndex();
  let clock = 1000;
  const cache = new AudioCache({ caches, index, pins: memoryPins(), now: () => clock });

  const key = cacheKey('fsa', '/Jazz/a.mp3');
  await cache.write({ key, source: 'fsa', path: 'Jazz/a.mp3', blob: blob(100) });

  const row = index.map.get(key);
  assert.equal(row.size, 100);
  assert.equal(row.lastAccess, 1000);
  assert.equal(await cache.total(), 100);

  clock = 2000;
  const read = await cache.read(key);
  assert.ok(read);
  assert.equal(read.size, 100);
  assert.equal(index.map.get(key).lastAccess, 2000);

  const missing = await cache.read(cacheKey('fsa', 'missing.mp3'));
  assert.equal(missing, null);
});

test('write evicts the oldest entry when over the limit', async () => {
  const caches = memoryCaches();
  const index = memoryIndex();
  let clock = 0;
  const cache = new AudioCache({ caches, index, pins: memoryPins(), now: () => ++clock });
  cache.limit = 150;

  const first = cacheKey('fsa', 'a.mp3');
  const second = cacheKey('fsa', 'b.mp3');

  await cache.write({ key: first, source: 'fsa', path: 'a.mp3', blob: blob(100) });
  assert.equal(await cache.total(), 100);

  await cache.write({ key: second, source: 'fsa', path: 'b.mp3', blob: blob(100) });

  assert.equal(index.map.has(first), false);
  assert.equal(index.map.has(second), true);
  assert.equal(await cache.total(), 100);
  assert.equal(await cache.read(first), null);
  assert.ok(await cache.read(second));
});

test('pinned entries survive eviction pressure', async () => {
  const caches = memoryCaches();
  const index = memoryIndex();
  const pins = memoryPins([{ id: 'pin-1', source: 'fsa', dir: 'Jazz' }]);
  let clock = 0;
  const cache = new AudioCache({ caches, index, pins, now: () => ++clock });
  cache.limit = 150;

  const pinned = cacheKey('fsa', 'Jazz/a.mp3');
  const other = cacheKey('fsa', 'Rock/b.mp3');

  await cache.write({ key: pinned, source: 'fsa', path: 'Jazz/a.mp3', blob: blob(100) });
  await cache.write({ key: other, source: 'fsa', path: 'Rock/b.mp3', blob: blob(100) });

  assert.equal(index.map.has(pinned), true);
  assert.equal(index.map.has(other), false);
  assert.ok(await cache.read(pinned));
  assert.equal(await cache.total(), 100);
});

test('remove deletes the cache entry and index row', async () => {
  const caches = memoryCaches();
  const index = memoryIndex();
  const cache = new AudioCache({ caches, index, pins: memoryPins() });
  const key = cacheKey('fsa', 'a.mp3');

  await cache.write({ key, source: 'fsa', path: 'a.mp3', blob: blob(64) });
  assert.equal(await cache.remove(key), true);
  assert.equal(index.map.has(key), false);
  assert.equal(await cache.total(), 0);
  assert.equal(await cache.remove(key), false);
});

test('clear releases indexed bytes and empties the cache', async () => {
  const caches = memoryCaches();
  const index = memoryIndex();
  const cache = new AudioCache({ caches, index, pins: memoryPins() });
  const first = cacheKey('fsa', 'a.mp3');
  const second = cacheKey('fsa', 'b.mp3');

  await cache.write({ key: first, source: 'fsa', path: 'a.mp3', blob: blob(100) });
  await cache.write({ key: second, source: 'fsa', path: 'b.mp3', blob: blob(50) });

  assert.equal(await cache.clear(), 150);
  assert.equal(index.map.size, 0);
  assert.equal(caches.entries.size, 0);
  assert.equal(await cache.read(first), null);
});

test('clear accounts for cache entries missing from the index', async () => {
  const caches = memoryCaches();
  const index = memoryIndex();
  const cache = new AudioCache({ caches, index, pins: memoryPins() });

  await cache.write({ key: cacheKey('fsa', 'a.mp3'), source: 'fsa', path: 'a.mp3', blob: blob(40) });
  const orphan = cacheRequest('fsa:orphan.mp3');
  await caches.open(AUDIO_CACHE_NAME).then((opened) => opened.put(orphan, new Response(blob(60))));

  assert.equal(await cache.clear(), 100);
  assert.equal(caches.entries.size, 0);
});

test('persist runs once before the first write', async () => {
  const caches = memoryCaches();
  const index = memoryIndex();
  let calls = 0;
  const cache = new AudioCache({
    caches,
    index,
    pins: memoryPins(),
    persist: async () => {
      calls += 1;
      return true;
    },
  });

  await cache.write({ key: cacheKey('fsa', 'a.mp3'), source: 'fsa', path: 'a.mp3', blob: blob(10) });
  await cache.write({ key: cacheKey('fsa', 'b.mp3'), source: 'fsa', path: 'b.mp3', blob: blob(10) });

  assert.equal(calls, 1);
});

test('read returns null when Cache Storage throws', async () => {
  const caches = memoryCaches({ failMatch: true });
  const index = memoryIndex();
  const cache = new AudioCache({ caches, index, pins: memoryPins() });
  const key = cacheKey('fsa', 'a.mp3');

  assert.equal(await cache.read(key), null);
});

test('cache index adapter stores, overwrites, deletes and clears rows', async () => {
  const db = fakeDb();
  const index = createCacheIndex(db);

  assert.deepEqual(await index.all(), []);

  await index.put({ key: 'a', size: 1 });
  await index.put({ key: 'a', size: 2 });
  assert.deepEqual(await index.all(), [{ key: 'a', size: 2 }]);

  await index.deleteByKeys([]);
  assert.equal((await index.all()).length, 1);

  await index.deleteByKeys(['a']);
  assert.deepEqual(await index.all(), []);

  await index.put({ key: 'b', size: 3 });
  await index.clear();
  assert.deepEqual(await index.all(), []);
  assert.equal(db.dataFor(CACHE_INDEX_STORE).size, 0);
});

test('pin store adapter stores, lists and deletes pins', async () => {
  const db = fakeDb();
  const pins = createPinStore(db);

  assert.deepEqual(await pins.all(), []);
  await pins.put({ id: 'p1', source: 'fsa', dir: 'Jazz' });
  assert.deepEqual(await pins.all(), [{ id: 'p1', source: 'fsa', dir: 'Jazz' }]);
  await pins.delete('p1');
  assert.deepEqual(await pins.all(), []);
  assert.equal(db.dataFor(PINS_STORE).size, 0);
});
