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
function harness({ readMetadata: reader, probeDuration } = {}) {
  const db = fakeDb();
  const meta = {
    reads: 0,
    reader: reader ?? (async () => ({ duration: 1000, cover: new Blob([new Uint8Array(4)]) })),
  };
  const probe = { calls: 0, resolve: null };
  const options = {
    readMetadata: async (blob, path) => {
      meta.reads += 1;
      return meta.reader(blob, path);
    },
  };
  if (probeDuration) {
    options.probeDuration = (blob) => {
      probe.calls += 1;
      return probeDuration(blob);
    };
  }
  const store = new Store(db, options);
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
    probe.calls = 0;
    db.ops.tracks.put = 0;
    db.ops.cacheIndex.put = 0;
  };
  return { db, store, storage, counts, meta, probe, listed, reset };
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

/** Simulate rows written by an older build, before `metaScanned` existed. */
function unmark(db, store) {
  for (const row of db.dataFor('tracks').values()) delete row.metaScanned;
  for (const row of store.state.tracks) delete row.metaScanned;
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

test('coverless tracks are read once and then never again', async () => {
  const { db, store, counts, meta, listed, reset } = harness({
    readMetadata: async () => ({ duration: 1000 }),
  });
  listed.splice(0, listed.length, ...entries(TRACKS));

  await store.rescan('onedrive');
  await settle(store);

  for (const track of store.state.tracks) {
    assert.equal(track.hasCover, false);
    assert.equal(track.metaScanned, true);
  }

  reset();
  await store.rescan('onedrive');

  assert.equal(counts.read, 0);
  assert.equal(counts.write, 0);
  assert.equal(meta.reads, 0);
  assert.equal(db.ops.tracks.put, 0);

  await settle(store);
});

test('rows from an older build are read once and marked, then skipped', async () => {
  const { db, store, counts, meta, listed, reset } = harness();
  listed.splice(0, listed.length, ...entries(TRACKS));
  await store.rescan('onedrive');
  await settle(store);

  unmark(db, store);
  reset();
  await store.rescan('onedrive');

  assert.equal(counts.read, 100);
  assert.equal(meta.reads, 100);
  for (const track of store.state.tracks) assert.equal(track.metaScanned, true);

  reset();
  await store.rescan('onedrive');

  assert.equal(counts.read, 0);
  assert.equal(meta.reads, 0);

  await settle(store);
});

test('a failed tag read leaves the row unmarked and is retried', async () => {
  const { db, store, counts, meta, listed, reset } = harness();
  listed.splice(0, listed.length, ...entries(TRACKS));
  await store.rescan('onedrive');
  await settle(store);

  unmark(db, store);
  meta.reader = async () => {
    throw new Error('unreadable');
  };
  reset();
  await store.rescan('onedrive');

  assert.equal(counts.read, 100);
  for (const track of store.state.tracks) assert.notEqual(track.metaScanned, true);

  meta.reader = async () => ({ duration: 1000, cover: new Blob([new Uint8Array(4)]) });
  reset();
  await store.rescan('onedrive');

  assert.equal(counts.read, 100);
  for (const track of store.state.tracks) assert.equal(track.metaScanned, true);

  reset();
  await store.rescan('onedrive');
  assert.equal(counts.read, 0);

  await settle(store);
});

test('a zero parsed duration is probed once and written to the row and the db', async () => {
  let releaseProbe = null;
  const { db, store, probe, listed, reset } = harness({
    readMetadata: async () => ({ duration: 0 }),
    probeDuration: () =>
      new Promise((resolve) => {
        releaseProbe = resolve;
      }),
  });
  listed.splice(0, listed.length, ...entries(1));

  await store.rescan('onedrive');

  assert.equal(store.state.tracks[0].duration, 0);
  assert.equal(store._probes.size, 1);
  assert.equal(probe.calls, 1);

  releaseProbe(250.5);
  await store._probeChain;
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(store.state.tracks[0].duration, 250.5);
  assert.equal(db.dataFor('tracks').get('onedrive:Music/t0.mp3').duration, 250.5);

  await settle(store);
  assert.equal(store.state.tracks[0].duration, 250.5);

  assert.equal(probe.calls, 1);
  reset();
  await store.rescan('onedrive');
  await settle(store);
  assert.equal(probe.calls, 0);
});

test('a parsed duration skips the audio probe', async () => {
  const { store, probe, listed } = harness({
    readMetadata: async () => ({ duration: 1000 }),
    probeDuration: async () => 999,
  });
  listed.splice(0, listed.length, ...entries(1));

  await store.rescan('onedrive');
  await settle(store);

  assert.equal(probe.calls, 0);
  assert.equal(store.state.tracks[0].duration, 1000);
});

test('a probe that finds nothing leaves the row unknown and the scan completes', async () => {
  const { store, listed } = harness({
    readMetadata: async () => ({ duration: 0 }),
    probeDuration: async () => 0,
  });
  listed.splice(0, listed.length, ...entries(1));

  const summary = await store.rescan('onedrive');
  await settle(store);

  assert.ok(summary);
  assert.equal(store.state.tracks[0].duration, 0);
  assert.equal(store.state.tracks[0].metaScanned, true);
  assert.equal(store.state.sources.find((row) => row.id === 'onedrive').error, null);
});

test('the tag pass keeps a duration that only the audio element knew', async () => {
  const { store } = harness({ readMetadata: async () => ({ duration: 0 }) });
  store._state.tracks = [
    {
      id: 'onedrive:Music/t0.mp3',
      path: 'Music/t0.mp3',
      title: 't0',
      duration: 250.5,
      source: 'onedrive',
    },
  ];
  store._enrich('onedrive', [
    { entry: { path: 'Music/t0.mp3', mtime: 1, size: 10 }, trackId: 'onedrive:Music/t0.mp3' },
  ]);
  await settle(store);

  assert.equal(store.state.tracks[0].duration, 250.5);
});
