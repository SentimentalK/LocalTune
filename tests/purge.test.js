import { test } from 'node:test';
import assert from 'node:assert/strict';

import { purgeSourceRows } from '../src/core/purge.js';

/** In-memory cache index double: rows keyed by cache key. */
function memoryCache(rows = []) {
  const entries = new Map(rows.map((row) => [row.key, { ...row }]));
  return {
    entries,
    async removeBySource(source) {
      let removed = 0;
      for (const [key, row] of entries) {
        if (row.source !== source) continue;
        entries.delete(key);
        removed += 1;
      }
      return removed;
    },
  };
}

function track(source, index) {
  return { id: `${source}:${index}`, source, path: `${source}/${index}.mp3` };
}

function cacheRow(trackRow) {
  return {
    key: trackRow.id,
    source: trackRow.source,
    path: trackRow.path,
    size: 1024,
    lastAccess: 0,
  };
}

function seed() {
  const tracks = [
    ...Array.from({ length: 100 }, (_, index) => track('onedrive', index)),
    ...Array.from({ length: 3 }, (_, index) => track('fsa', index)),
  ];
  return { tracks, cache: memoryCache(tracks.map(cacheRow)) };
}

test('purge drops only the switched source rows and reports them', async () => {
  const { tracks, cache } = seed();
  const deleted = [];
  let reported = null;

  const removed = await purgeSourceRows({
    source: 'onedrive',
    tracks,
    deleteTracks: async (ids) => {
      deleted.push(...ids);
    },
    cache,
    onRemoved: (ids) => {
      reported = ids;
    },
  });

  assert.equal(removed.length, 100);
  assert.deepEqual(deleted, removed);
  assert.deepEqual(reported, removed);
  assert.ok(removed.every((id) => id.startsWith('onedrive:')), 'only onedrive ids');
});

test('purge leaves the other source cache rows intact', async () => {
  const { tracks, cache } = seed();

  await purgeSourceRows({
    source: 'onedrive',
    tracks,
    deleteTracks: async () => {},
    cache,
  });

  assert.equal(cache.entries.size, 3);
  assert.deepEqual(
    [...cache.entries.keys()].sort(),
    ['fsa:0', 'fsa:1', 'fsa:2'],
  );
});

test('a new root leaves only its own five rows and cache keys', async () => {
  const { tracks, cache } = seed();
  let state = tracks;

  await purgeSourceRows({
    source: 'onedrive',
    tracks: state,
    deleteTracks: async () => {},
    cache,
    onRemoved: (ids) => {
      const removed = new Set(ids);
      state = state.filter((row) => !removed.has(row.id));
    },
  });

  const next = Array.from({ length: 5 }, (_, index) => ({
    ...track('onedrive', index),
    path: `Music2/${index}.mp3`,
    id: `onedrive:new${index}`,
  }));
  state = [...state, ...next];
  for (const row of next) cache.entries.set(row.id, cacheRow(row));

  assert.equal(cache.entries.size, 8);
  for (const row of next) assert.ok(cache.entries.has(row.id), row.id);
  for (let index = 0; index < 100; index += 1) {
    assert.ok(!cache.entries.has(`onedrive:${index}`), `stale onedrive:${index}`);
  }
  assert.equal(state.filter((row) => row.source === 'onedrive').length, 5);
});
