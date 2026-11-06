import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/core/store.js';
import { AudioCache, cacheKey, cacheRequest } from '../src/core/cache/audioCache.js';
import { createCacheIndex } from '../src/core/cache/index.js';

/** In-memory IndexedDB double: one Map per store, sync ops, microtask completion. */
function fakeDb() {
  const stores = new Map();
  const ops = { tracks: { put: 0 }, cacheIndex: { put: 0 } };
  const dataFor = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };
  const request = (compute) => {
    const req = {};
    queueMicrotask(() => {
      try {
        req.result = compute();
        req.onsuccess?.();
      } catch (error) {
        req.error = error;
        req.onerror?.();
      }
    });
    return req;
  };
  return {
    stores,
    ops,
    dataFor,
    transaction(name) {
      const names = Array.isArray(name) ? name : [name];
      const tx = { error: null };
      tx.objectStore = (storeName) => {
        const key = storeName ?? names[0];
        const data = dataFor(key);
        return {
          getAll() {
            return request(() => [...data.values()].map((row) => ({ ...row })));
          },
          get(id) {
            return request(() => data.get(id));
          },
          put(row) {
            if (ops[key]) ops[key].put += 1;
            data.set(row.key ?? row.id, { ...row });
          },
          delete(id) {
            data.delete(id);
          },
          clear() {
            data.clear();
          },
        };
      };
      queueMicrotask(() => tx.oncomplete?.());
      return tx;
    },
  };
}

/** Cache Storage double; responses are re-created per lookup. */
function memoryCaches() {
  const entries = new Map();
  const url = (input) => (typeof input === 'string' ? input : input.url);
  const cache = {
    async put(input, response) {
      entries.set(url(input), await response.blob());
    },
    async match(input) {
      const stored = entries.get(url(input));
      return stored ? new Response(stored) : undefined;
    },
    async delete(input) {
      return entries.delete(url(input));
    },
    async keys() {
      return [...entries.keys()].map((key) => new Request(key));
    },
  };
  return {
    entries,
    async open() {
      return cache;
    },
    async keys() {
      return ['audio-v1'];
    },
  };
}

const TRACKS = 100;
const CACHED_BYTES = 10;

/** Store + counting AudioCache + counting metadata reader, wired for rescan. */
function harness() {
  const db = fakeDb();
  const meta = { reads: 0 };
  const store = new Store(db, {
    readMetadata: async () => {
      meta.reads += 1;
      return { duration: 1000, cover: new Blob([new Uint8Array(4)]) };
    },
  });
  const storage = memoryCaches();
  const audio = new AudioCache({ caches: storage, index: createCacheIndex(db) });
  const counts = { read: 0, write: 0, has: 0 };
  for (const method of ['read', 'write', 'has']) {
    const original = audio[method].bind(audio);
    audio[method] = (...args) => {
      counts[method] += 1;
      return original(...args);
    };
  }
  store.cache = audio;

  /** Mirrors OneDriveSource.getFile: the adapter owns the cache write. */
  const listed = [];
  store.sources.onedrive = {
    kind: 'onedrive',
    trackSource: 'onedrive',
    cacheWholeFiles: true,
    name: 'OneDrive',
    permission: () => 'granted',
    ensurePermission: async () => true,
    root: () => null,
    async *scan() {
      for (const entry of listed) yield entry;
    },
    async getFile(path) {
      const blob = new Blob([new Uint8Array(CACHED_BYTES)]);
      await store.cache.write({ key: cacheKey('onedrive', path), source: 'onedrive', path, blob });
      return blob;
    },
  };
  const reset = () => {
    for (const key of Object.keys(counts)) counts[key] = 0;
    meta.reads = 0;
    db.ops.tracks.put = 0;
    db.ops.cacheIndex.put = 0;
  };
  return { db, store, storage, counts, meta, listed, reset };
}

function entries(count) {
  return Array.from({ length: count }, (_, index) => ({
    path: `Music/t${index}.mp3`,
    mtime: 1,
    size: CACHED_BYTES,
  }));
}

/** A tag/cover pass is queued in the background; let it settle. */
async function settle(store) {
  for (let i = 0; i < 500 && store._enrichQueues.size; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test('a second rescan of complete cached tracks reads no audio and no tags', async () => {
  const { db, store, counts, meta, listed, reset } = harness();
  listed.splice(0, listed.length, ...entries(TRACKS));

  await store.rescan('onedrive');

  assert.equal(store.state.tracks.length, TRACKS);
  for (const track of store.state.tracks) {
    assert.ok(track.duration > 0);
    assert.equal(track.hasCover, true);
  }

  await settle(store);
  reset();
  await store.rescan('onedrive');

  assert.equal(counts.read, 0);
  assert.equal(counts.write, 0);
  assert.equal(meta.reads, 0);
  assert.equal(db.ops.tracks.put, 0);
  assert.equal(db.dataFor('tracks').size, TRACKS);

  await settle(store);
});

test('removing 20 tracks and adding 10 deletes their cache entries and writes only the new ones', async () => {
  const { db, store, storage, counts, listed, reset } = harness();
  listed.splice(0, listed.length, ...entries(TRACKS));
  await store.rescan('onedrive');
  await settle(store);

  const kept = entries(80);
  const added = Array.from({ length: 10 }, (_, index) => ({
    path: `Music/new-${index}.mp3`,
    mtime: 2,
    size: CACHED_BYTES,
  }));
  listed.splice(0, listed.length, ...kept, ...added);
  reset();

  const summary = await store.rescan('onedrive');

  assert.equal(summary.added, 10);
  assert.equal(summary.updated, 0);
  assert.equal(summary.removed, 20);
  assert.equal(counts.write, 10);
  assert.equal(counts.read, 0);

  for (let i = 80; i < 100; i += 1) {
    const key = cacheKey('onedrive', `Music/t${i}.mp3`);
    assert.equal(await store.cache.has(key), false, `${key} still cached`);
    assert.equal(db.dataFor('cacheIndex').has(key), false, `${key} still indexed`);
    assert.equal(storage.entries.has(cacheRequest(key).url), false, `${key} bytes remain`);
  }

  const index = db.dataFor('cacheIndex');
  assert.equal(index.size, 90);
  assert.equal(db.dataFor('tracks').size, 90);
  assert.equal(storage.entries.size, 90);

  const listedKeys = new Set(
    [...kept, ...added].map((entry) => cacheKey('onedrive', entry.path)),
  );
  for (const key of index.keys()) assert.ok(listedKeys.has(key), `${key} is not listed`);
  for (const key of listedKeys) {
    assert.ok(storage.entries.has(cacheRequest(key).url), `${key} missing from Cache Storage`);
  }

  await settle(store);
});
