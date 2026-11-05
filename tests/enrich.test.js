import { test } from 'node:test';
import assert from 'node:assert/strict';

import { enrichTracks } from '../src/core/enrich.js';

test('enrichTracks isolates failing files and keeps the rest of the batch', async () => {
  const seen = [];
  const progress = [];
  const items = [
    {
      entry: {
        path: 'a.mp3',
        readFile: async () => {
          throw new Error('remote read failed');
        },
      },
    },
    {
      entry: {
        path: 'b.mp3',
        readFile: async () => ({ name: 'b.mp3' }),
      },
    },
    {
      entry: {
        path: 'c.mp3',
        readFile: async () => ({ name: 'c.mp3' }),
      },
    },
  ];

  const result = await enrichTracks({
    items,
    readMetadata: async (file) => {
      if (file?.name === 'b.mp3') throw new Error('metadata parse failed');
      return { title: 'C title' };
    },
    makeTrack: (entry, meta) => ({ id: entry.path, title: meta.title ?? entry.path }),
    onTrack: async (track) => {
      seen.push(track.id);
    },
    onProgress: (row) => progress.push(row),
  });

  assert.deepEqual(result, { updated: 1, failed: 2 });
  assert.deepEqual(seen, ['c.mp3']);
  assert.deepEqual(
    progress.map((row) => row.done),
    [1, 2, 3],
  );
  assert.deepEqual(progress.at(-1), { done: 3, total: 3, updated: 1, failed: 2 });
});

test('enrichTracks skips vetoed items, reads entry.file, and counts a rejected onTrack', async () => {
  const items = [
    { entry: { path: 'skip.mp3', file: { name: 'skip.mp3' } } },
    { entry: { path: 'file.mp3', file: { name: 'file.mp3' } } },
    { entry: { path: 'reject.mp3', file: { name: 'reject.mp3' } } },
  ];
  const visited = [];

  const result = await enrichTracks({
    items,
    shouldUpdate: (item) => item.entry.path !== 'skip.mp3',
    readMetadata: async (file) => {
      visited.push(file.name);
      return { title: file.name };
    },
    makeTrack: (entry, meta) => ({ id: entry.path, title: meta.title }),
    onTrack: async (track) => {
      if (track.id === 'reject.mp3') throw new Error('store rejected');
    },
  });

  assert.deepEqual(visited, ['file.mp3', 'reject.mp3']);
  assert.deepEqual(result, { updated: 1, failed: 1 });
});
