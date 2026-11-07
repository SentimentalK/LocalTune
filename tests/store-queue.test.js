import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/core/store.js';
import { createQueue, setQueue, toggleShuffle, currentTrack } from '../src/core/queue.js';

/** In-memory IndexedDB double: one Map per store, microtask completion. */
function fakeDb() {
  const stores = new Map();
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
    transaction(name) {
      const names = Array.isArray(name) ? name : [name];
      const tx = { error: null };
      tx.objectStore = (storeName) => {
        const data = dataFor(storeName ?? names[0]);
        return {
          getAll: () => request(() => [...data.values()].map((row) => ({ ...row }))),
          get: (id) => request(() => data.get(id)),
          put(row) {
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

const TRACKS = Array.from({ length: 8 }, (_, i) => ({
  id: `fsa:${String.fromCharCode(97 + i)}.mp3`,
  path: `${String.fromCharCode(97 + i)}.mp3`,
  title: String.fromCharCode(65 + i),
  source: 'fsa',
  duration: 60,
}));

/** Store with a stub player; queue transitions are the unit under test. */
function harness(tracks = TRACKS) {
  const store = new Store(fakeDb());
  store.player = {
    disableLeveling() {},
    pause() {},
    setVolume() {},
    seek() {},
  };
  store._loadTrack = async () => true;
  store._syncMediaSession = () => {};
  store._savePlayback = () => {};
  store._state.tracks = tracks;
  store.queue = toggleShuffle(setQueue(createQueue([]), tracks, 0));
  store._reflectQueue();
  return store;
}

/** Drain from the current track to the end, recording every track played. */
async function roundFrom(store) {
  const seen = [currentTrack(store.queue).id];
  for (;;) {
    const before = store.queue;
    await store.next();
    if (store.queue === before) return seen;
    seen.push(currentTrack(store.queue).id);
  }
}

test('tapping a row mid-shuffle keeps the round and never repeats a track', async () => {
  const store = harness();
  const played = [currentTrack(store.queue).id];
  await store.next();
  played.push(currentTrack(store.queue).id);
  const orderBefore = store.queue.order;
  // The next row in play order is unplayed; tapping it skips nothing.
  const nextIndex = store.queue.order[store.queue.cursor + 1];

  await store.playQueue(TRACKS, TRACKS[nextIndex].id);
  assert.deepEqual(store.queue.order, orderBefore, 'row tap must not reshuffle');
  assert.equal(currentTrack(store.queue).id, TRACKS[nextIndex].id);

  const after = [...played, ...(await roundFrom(store))];
  assert.equal(new Set(after).size, TRACKS.length, 'one round plays every track once');
  assert.deepEqual([...after].sort(), TRACKS.map((track) => track.id).sort(), 'nothing is skipped');
});

test('playTrack on the same library preserves the running shuffle round', async () => {
  const store = harness();
  const orderBefore = store.queue.order;
  const target = TRACKS[5];
  await store.playTrack(target.id);
  assert.deepEqual(store.queue.order, orderBefore);
  assert.equal(currentTrack(store.queue).id, target.id);
  const seen = await roundFrom(store);
  assert.equal(new Set(seen).size, seen.length, 'the remainder has no repeats');
});

test('metadata backfill that replaces queue rows keeps order and the round', async () => {
  const store = harness();
  await store.next();
  const before = {
    order: store.queue.order,
    cursor: store.queue.cursor,
    index: store.queue.index,
  };
  // Same shape as the enrich/duration passes: in-place row replacement.
  store.queue = {
    ...store.queue,
    tracks: store.queue.tracks.map((track) => ({ ...track, duration: 123.5 })),
  };
  store._reflectQueue();
  assert.deepEqual(store.queue.order, before.order);
  assert.equal(store.queue.cursor, before.cursor);
  assert.equal(store.queue.index, before.index);

  const from = store.queue.cursor;
  const seen = await roundFrom(store);
  assert.equal(new Set(seen).size, seen.length);
  assert.equal(seen.length, TRACKS.length - from);
});

test('appendQueue during shuffle does not recycle the played pool', async () => {
  const store = harness();
  const played = [currentTrack(store.queue).id];
  await store.next();
  const kept = { index: store.queue.index, cursor: store.queue.cursor, order: store.queue.order };
  const extra = [
    { id: 'fsa:n1.mp3', path: 'n1.mp3', title: 'N1', source: 'fsa', duration: 60 },
    { id: 'fsa:n2.mp3', path: 'n2.mp3', title: 'N2', source: 'fsa', duration: 60 },
  ];

  store.appendQueue(extra);
  assert.equal(store.queue.index, kept.index, 'the playhead does not move');
  assert.equal(store.queue.cursor, kept.cursor);
  assert.deepEqual(store.queue.order.slice(0, kept.order.length), kept.order);

  const seen = [...played, ...(await roundFrom(store))];
  assert.equal(new Set(seen).size, TRACKS.length + extra.length);
  assert.deepEqual(
    [...seen].sort(),
    [...TRACKS, ...extra].map((track) => track.id).sort(),
    'unplayed tracks and the new arrivals each play once',
  );
});

test('tapping an already-played track replays it once and keeps the rest gap-free', async () => {
  const store = harness();
  await store.next();
  await store.next();
  const orderBefore = store.queue.order;
  const playedFirst = orderBefore[0];
  const playedId = TRACKS[playedFirst].id;

  await store.jumpTo(playedFirst);
  assert.deepEqual(store.queue.order, orderBefore, 'jump does not rebuild the order');
  assert.equal(currentTrack(store.queue).id, playedId);
  const cursor = store.queue.cursor;

  const seen = await roundFrom(store);
  assert.deepEqual(
    seen,
    orderBefore.slice(cursor).map((i) => TRACKS[i].id),
    'no auto repeats',
  );
});
