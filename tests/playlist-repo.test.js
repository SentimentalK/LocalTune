import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPlaylistRepo } from '../src/core/playlist/repo.js';

// In-memory stand-ins for the `playlists` store operations.
function createOps(rows = []) {
  const table = new Map(rows.map((row, index) => [row?.id ?? `row_${index}`, row]));
  return {
    table,
    ops: {
      async all() {
        return Array.from(table.values());
      },
      async put(playlist) {
        table.set(playlist.id, structuredClone(playlist));
      },
      async remove(id) {
        table.delete(id);
      },
    },
  };
}

function playlistOf(id, createdAt, patch = {}) {
  return {
    id,
    name: id,
    source: 'text',
    sourceUrl: null,
    items: [],
    createdAt,
    ...patch,
  };
}

test('save writes a normalized row that list returns', async () => {
  const { ops } = createOps();
  const repo = createPlaylistRepo(ops);

  const saved = await repo.save(playlistOf('pl_1_aaaaaa', 10, { name: '  Road  ' }));
  assert.equal(saved.name, 'Road');

  const [row] = await repo.list();
  assert.deepEqual(row, saved);
});

test('list sorts by createdAt descending', async () => {
  const { ops } = createOps([
    playlistOf('pl_old_aaaaaa', 1),
    playlistOf('pl_new_bbbbbb', 30),
    playlistOf('pl_mid_cccccc', 15),
  ]);
  const repo = createPlaylistRepo(ops);

  assert.deepEqual(
    (await repo.list()).map((row) => row.id),
    ['pl_new_bbbbbb', 'pl_mid_cccccc', 'pl_old_aaaaaa'],
  );
});

test('list orders equal timestamps by id', async () => {
  const { ops } = createOps([
    playlistOf('pl_b_bbbbbb', 5),
    playlistOf('pl_a_aaaaaa', 5),
    playlistOf('pl_c_cccccc', 5),
  ]);
  const repo = createPlaylistRepo(ops);

  assert.deepEqual(
    (await repo.list()).map((row) => row.id),
    ['pl_a_aaaaaa', 'pl_b_bbbbbb', 'pl_c_cccccc'],
  );
});

test('save normalizes illegal source, status and source url', async () => {
  const { ops } = createOps();
  const repo = createPlaylistRepo(ops);

  const saved = await repo.save(
    playlistOf('pl_1_aaaaaa', 1, {
      source: 'deezer',
      sourceUrl: 'ftp://example.com/list',
      items: [{ title: 'Song', status: 'matched', reasons: ['tempo'] }],
    }),
  );

  assert.equal(saved.source, 'text');
  assert.equal(saved.sourceUrl, null);
  assert.equal(saved.items[0].status, 'missing');
  assert.deepEqual(saved.items[0].reasons, []);
  assert.equal(saved.items[0].matchedTrackId, null);
});

test('remove deletes the row', async () => {
  const { ops, table } = createOps([
    playlistOf('pl_a_aaaaaa', 1),
    playlistOf('pl_b_bbbbbb', 2),
  ]);
  const repo = createPlaylistRepo(ops);

  await repo.remove('pl_a_aaaaaa');
  assert.ok(!table.has('pl_a_aaaaaa'));
  assert.deepEqual(
    (await repo.list()).map((row) => row.id),
    ['pl_b_bbbbbb'],
  );
});

test('list filters rows without a usable id', async () => {
  const { ops } = createOps([
    playlistOf('pl_ok_aaaaaa', 1),
    { name: 'no id', items: [], createdAt: 2 },
    { id: '', name: 'empty id', items: [], createdAt: 3 },
    { id: 42, name: 'numeric id', items: [], createdAt: 4 },
    null,
  ]);
  const repo = createPlaylistRepo(ops);

  assert.deepEqual(
    (await repo.list()).map((row) => row.id),
    ['pl_ok_aaaaaa'],
  );
});

test('list falls back to an empty array when the store returns a non-array', async () => {
  const repo = createPlaylistRepo({
    async all() {
      return null;
    },
    async put() {},
    async remove() {},
  });

  assert.deepEqual(await repo.list(), []);
});
