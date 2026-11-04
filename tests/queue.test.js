import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createQueue,
  setQueue,
  currentTrack,
  advance,
  back,
  toggleShuffle,
  cycleRepeat,
  removeAt,
} from '../src/core/queue.js';

const TRACKS = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];

function queueAt(index, extra = {}) {
  const state = setQueue(createQueue(TRACKS), TRACKS, index);
  return { ...state, ...extra };
}

test('createQueue starts empty with index -1', () => {
  const state = createQueue();
  assert.deepEqual(state.tracks, []);
  assert.equal(state.index, -1);
  assert.deepEqual(state.order, []);
  assert.equal(state.shuffle, false);
  assert.equal(state.repeat, 'off');
});

test('setQueue returns a new state and clamps the start index', () => {
  const empty = createQueue();
  const state = setQueue(empty, TRACKS, 99);
  assert.notEqual(state, empty);
  assert.equal(state.index, 3);
  assert.deepEqual(state.order, [0, 1, 2, 3]);
  assert.equal(state.cursor, 3);
  assert.deepEqual(empty.tracks, []);
  assert.equal(empty.index, -1);

  const negative = setQueue(empty, TRACKS, -5);
  assert.equal(negative.index, 0);
});

test('advance moves forward along the order', () => {
  const start = queueAt(1);
  const { state, ended } = advance(start, { auto: false });
  assert.equal(ended, false);
  assert.equal(state.index, 2);
  assert.equal(currentTrack(state).id, 'c');
  assert.equal(start.index, 1, 'original state untouched');
});

test('advance auto:false at the end with repeat off stays on the last track', () => {
  const start = queueAt(3);
  const { state, ended } = advance(start, { auto: false });
  assert.equal(ended, true);
  assert.equal(state, start);
  assert.equal(currentTrack(state).id, 'd');
});

test('advance auto:true at the end with repeat off reports ended', () => {
  const start = queueAt(3);
  const { state, ended } = advance(start, { auto: true });
  assert.equal(ended, true);
  assert.equal(state, start);
});

test('advance auto:true with repeat one repeats the same track', () => {
  const start = queueAt(2, { repeat: 'one' });
  const { state, ended } = advance(start, { auto: true });
  assert.equal(ended, false);
  assert.equal(state, start);
  assert.equal(currentTrack(state).id, 'c');
});

test('repeat one still advances for user-initiated next', () => {
  const start = queueAt(1, { repeat: 'one' });
  const { state, ended } = advance(start, { auto: false });
  assert.equal(ended, false);
  assert.equal(state.index, 2);
});

test('repeat all wraps to the first track on both auto and manual advance', () => {
  const auto = advance(queueAt(3, { repeat: 'all' }), { auto: true });
  assert.equal(auto.ended, false);
  assert.equal(auto.state.index, 0);
  assert.equal(auto.state.cursor, 0);

  const manual = advance(queueAt(3, { repeat: 'all' }), { auto: false });
  assert.equal(manual.ended, false);
  assert.equal(manual.state.index, 0);
});

test('advance on an empty queue ends immediately', () => {
  const empty = createQueue([]);
  assert.deepEqual(advance(empty, { auto: true }), { state: empty, ended: true });
});

test('back moves backwards and respects repeat', () => {
  const mid = back(queueAt(2));
  assert.equal(mid.state.index, 1);

  const first = queueAt(0);
  assert.equal(back(first).state, first);

  const wrapped = back(queueAt(0, { repeat: 'all' }));
  assert.equal(wrapped.state.index, 3);
  assert.equal(wrapped.state.cursor, 3);

  const empty = createQueue([]);
  assert.equal(back(empty).state, empty);
});

test('toggleShuffle keeps the current track and reorders the rest', () => {
  const start = queueAt(2);
  const shuffled = toggleShuffle(start);
  assert.equal(shuffled.shuffle, true);
  assert.notEqual(shuffled, start);
  assert.equal(shuffled.index, start.index);
  assert.equal(currentTrack(shuffled).id, 'c');
  assert.equal(shuffled.order[0], 2, 'current track is first in order');
  assert.equal(shuffled.cursor, 0);
  assert.deepEqual(
    [...shuffled.order].sort((x, y) => x - y),
    [0, 1, 2, 3],
    'order is a permutation',
  );

  const restored = toggleShuffle(shuffled);
  assert.equal(restored.shuffle, false);
  assert.deepEqual(restored.order, [0, 1, 2, 3]);
  assert.equal(restored.index, start.index);
  assert.equal(restored.cursor, start.index);
});

test('advance follows shuffle order', () => {
  const shuffled = toggleShuffle(queueAt(1));
  const { state } = advance(shuffled, { auto: false });
  assert.equal(state.cursor, 1);
  assert.equal(state.index, shuffled.order[1]);
  assert.equal(currentTrack(state).id, TRACKS[shuffled.order[1]].id);
});

test('cycleRepeat cycles off -> all -> one -> off', () => {
  let state = createQueue(TRACKS);
  const seen = [];
  for (let i = 0; i < 4; i += 1) {
    state = cycleRepeat(state);
    seen.push(state.repeat);
  }
  assert.deepEqual(seen, ['all', 'one', 'off', 'all']);
});

test('removeAt keeps the current track when removing an earlier entry', () => {
  const start = queueAt(2);
  const next = removeAt(start, 0);
  assert.notEqual(next, start);
  assert.equal(currentTrack(next).id, 'c');
  assert.equal(next.index, 1);
  assert.equal(next.order[next.cursor], next.index);
  assert.deepEqual(next.tracks.map((track) => track.id), ['b', 'c', 'd']);
  assert.equal(start.tracks.length, 4, 'original untouched');
});

test('removeAt keeps the current track when removing a later entry', () => {
  const start = queueAt(1);
  const next = removeAt(start, 3);
  assert.equal(currentTrack(next).id, 'b');
  assert.equal(next.index, 1);
  assert.deepEqual(next.tracks.map((track) => track.id), ['a', 'b', 'c']);
});

test('removeAt of the current track selects the next track in the same slot', () => {
  const start = queueAt(1);
  const next = removeAt(start, 1);
  assert.deepEqual(next.tracks.map((track) => track.id), ['a', 'c', 'd']);
  assert.equal(next.index, 1);
  assert.equal(currentTrack(next).id, 'c');
  assert.equal(next.order[next.cursor], 1);
});

test('removeAt clamps when the last track is the current one', () => {
  const start = queueAt(3);
  const next = removeAt(start, 3);
  assert.deepEqual(next.tracks.map((track) => track.id), ['a', 'b', 'c']);
  assert.equal(next.index, 2);
  assert.equal(currentTrack(next).id, 'c');
});

test('removeAt on the only track empties the queue', () => {
  const single = setQueue(createQueue([]), [TRACKS[0]], 0);
  const next = removeAt(single, 0);
  assert.deepEqual(next.tracks, []);
  assert.equal(next.index, -1);
  assert.deepEqual(next.order, []);
  assert.equal(next.cursor, 0);
});

test('removeAt with an invalid index returns the same state', () => {
  const start = queueAt(1);
  assert.equal(removeAt(start, -1), start);
  assert.equal(removeAt(start, 9), start);
  assert.equal(removeAt(start, 1.5), start);
});

test('removeAt with shuffle keeps order indices valid', () => {
  const start = toggleShuffle(queueAt(2));
  const next = removeAt(start, 0);
  assert.equal(next.order.length, 3);
  for (const i of next.order) {
    assert.ok(Number.isInteger(i) && i >= 0 && i < next.tracks.length);
  }
  assert.equal(next.index, next.order[next.cursor]);
  assert.equal(currentTrack(next).id, 'c');
});
