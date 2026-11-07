import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createQueue,
  setQueue,
  alignQueue,
  appendQueue,
  restoreRound,
  moveTo,
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

test('repeat all starts a fresh round that never opens with the track just played', () => {
  const before = queueAt(3, { repeat: 'all' });
  const lastPlayed = before.index;
  for (let i = 0; i < 50; i += 1) {
    const { state, ended } = advance(before, { auto: i % 2 === 0 });
    assert.equal(ended, false);
    assert.equal(state.cursor, 0);
    assert.equal(state.order[0], state.index, 'cursor and index agree');
    assert.notEqual(state.index, lastPlayed, 'new round does not replay the last track');
    assert.deepEqual(
      [...state.order].sort((x, y) => x - y),
      [0, 1, 2, 3],
      'new round is a permutation',
    );
  }
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

// --- Round properties -------------------------------------------------------
// A round is `order` from `cursor` onwards. With repeat off, advance visits
// every remaining entry exactly once; explicit moves may re-enter an entry,
// automatic advance never does.

function tracksOf(length) {
  return Array.from({ length }, (_, i) => ({ id: `t${i}` }));
}

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function permutation(length, random) {
  const order = Array.from({ length }, (_, i) => i);
  for (let i = length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/** A hand-built shuffling queue: arbitrary permutation, arbitrary cursor. */
function shufflingAt(tracks, order, cursor, extra = {}) {
  const base = setQueue(createQueue(tracks), tracks, 0);
  return {
    ...base,
    ...extra,
    shuffle: true,
    order: [...order],
    cursor,
    index: order[cursor],
  };
}

function assertRound(state) {
  assert.equal(state.order.length, state.tracks.length);
  assert.deepEqual([...state.order].sort((x, y) => x - y), state.order.map((_, i) => i));
  assert.equal(state.order[state.cursor], state.index, 'cursor and index agree');
}

function walkForward(state) {
  const seen = [state.index];
  let current = state;
  for (;;) {
    const { state: next, ended } = advance(current, { auto: true });
    if (ended) return { seen, final: current };
    assert.notEqual(next, current, 'a non-ended advance must make progress');
    assertRound(next);
    seen.push(next.index);
    current = next;
  }
}

test('property: repeat off advance visits the remaining round exactly once', () => {
  for (const length of [1, 2, 3, 5, 8]) {
    const tracks = tracksOf(length);
    for (let seed = 1; seed <= 12; seed += 1) {
      const order = permutation(length, lcg(seed * 7919 + length));
      for (let start = 0; start < length; start += 1) {
        const state = shufflingAt(tracks, order, start);
        assertRound(state);
        const { seen } = walkForward(state);
        // Starting track plus everything after it, each index exactly once.
        assert.deepEqual(seen, order.slice(start));
      }
    }
  }
});

test('property: a full round from the first cursor covers the whole queue once', () => {
  for (const length of [1, 2, 4, 7]) {
    const tracks = tracksOf(length);
    for (let seed = 1; seed <= 12; seed += 1) {
      const order = permutation(length, lcg(seed * 104729 + length));
      const { seen } = walkForward(shufflingAt(tracks, order, 0));
      assert.deepEqual([...seen].sort((x, y) => x - y), tracks.map((_, i) => i));
      assert.equal(new Set(seen).size, length, 'no duplicate inside one round');
    }
  }
});

test('property: repeat off back visits the round backwards exactly once', () => {
  for (const length of [1, 2, 5]) {
    const tracks = tracksOf(length);
    for (let seed = 1; seed <= 8; seed += 1) {
      const order = permutation(length, lcg(seed * 31337 + length));
      for (let start = 0; start < length; start += 1) {
        const seen = [order[start]];
        let state = shufflingAt(tracks, order, start);
        for (;;) {
          const { state: next } = back(state);
          if (next === state) break;
          assertRound(next);
          assert.equal(next.order[next.cursor], next.index);
          seen.push(next.index);
          state = next;
        }
        assert.deepEqual(seen, order.slice(0, start + 1).reverse());
      }
    }
  }
});

test('property: removeAt keeps order a permutation and the round gap-free', () => {
  for (const length of [2, 3, 6]) {
    const tracks = tracksOf(length);
    for (let seed = 1; seed <= 8; seed += 1) {
      const order = permutation(length, lcg(seed * 271 + length));
      for (let cursor = 0; cursor < length; cursor += 1) {
        for (let removeIndex = 0; removeIndex < length; removeIndex += 1) {
          const state = shufflingAt(tracks, order, cursor);
          const next = removeAt(state, removeIndex);
          assertRound(next);
          if (removeIndex === order[cursor]) {
            const expected = Math.min(cursor, next.order.length - 1);
            assert.equal(next.cursor, expected, 'the successor takes the freed slot');
          }
          const { seen } = walkForward(next);
          assert.deepEqual(seen, next.order.slice(next.cursor), 'no gap and no repeat');
        }
      }
    }
  }
});

test('moveTo plays a chosen track once and advance continues without repeats', () => {
  const tracks = tracksOf(6);
  for (let seed = 1; seed <= 10; seed += 1) {
    const order = permutation(6, lcg(seed));
    const progressed = walkForward(shufflingAt(tracks, order, 0)).final;
    const played = progressed.order[0];
    const moved = moveTo(progressed, played);
    assertRound(moved);
    assert.equal(moved.index, played, 'an explicit tap replays the played track');
    assert.equal(moved.order[moved.cursor], played);
    const { seen } = walkForward(moved);
    assert.deepEqual(seen, order.slice(moved.cursor), 'auto advance does not repeat');
    assert.equal(new Set(seen).size, seen.length);
  }
});

test('alignQueue remaps order by track id when the same set is reordered', () => {
  const tracks = TRACKS;
  const order = [2, 0, 3, 1];
  const state = {
    ...setQueue(createQueue(tracks), tracks, 0),
    shuffle: true,
    order: [...order],
    cursor: 1,
    index: order[1],
  };
  const reordered = [tracks[3], tracks[0], tracks[1], tracks[2]];
  const aligned = alignQueue(state, reordered, 2);
  assert.ok(aligned);
  assert.deepEqual(aligned.tracks, reordered);
  // Order ids: c,a,d,b -> reordered indices 3,1,0,2.
  assert.deepEqual(aligned.order, [3, 1, 0, 2]);
  assert.equal(aligned.index, 2, 'the requested track is current');
  assert.equal(aligned.order[aligned.cursor], 2);
  assert.equal(currentTrack(aligned).id, 'b');
  const { seen } = walkForward(aligned);
  assert.deepEqual(seen, [2]);
  assert.equal(alignQueue(state, [tracks[0]], 0), null, 'a different set is refused');
});

test('appendQueue extends the round at the tail and keeps the playhead', () => {
  const tracks = tracksOf(4);
  const order = [
    [0, 1, 2, 3],
    [3, 2, 1, 0],
  ];
  for (const perm of order) {
    const state = walkForward(shufflingAt(tracks, perm, 0)).final;
    assert.ok(state.cursor > 0);
    const appended = [{ id: 'x' }, { id: 'y' }];
    const next = appendQueue(state, appended);
    assert.equal(next.index, state.index);
    assert.equal(next.cursor, state.cursor);
    assert.deepEqual(next.order.slice(0, state.order.length), state.order);
    assert.deepEqual([...next.order].sort((x, y) => x - y), [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(next.tracks.slice(0, 4), tracks);
    assert.deepEqual(next.tracks.slice(4), appended);
    const { seen } = walkForward(next);
    assert.deepEqual(seen, next.order.slice(next.cursor), 'played tracks never come back');
  }
});

test('restoreRound keeps surviving ids in order and appends new tracks', () => {
  const tracks = tracksOf(5);
  const state = shufflingAt(tracks, [4, 2, 0, 3, 1], 2);
  const stored = { ids: ['t4', 't2', 't1'], indexId: 't2' };
  // t1 was deleted from the round; t0/t3 are still queued but unplayed.
  const grown = [...tracks, { id: 'new' }];
  const restored = restoreRound({ ...state, tracks: grown, order: [4, 2, 0, 3, 1, 5], cursor: 1, index: 2 }, stored);
  assert.ok(restored);
  assert.deepEqual(restored.order.slice(0, 2), [4, 2]);
  assert.deepEqual([...restored.order].sort((x, y) => x - y), [0, 1, 2, 3, 4, 5]);
  assert.equal(restored.index, 2);
  assert.equal(restored.order[restored.cursor], 2);
  assert.ok(restored.order.includes(5), 'new ids join the tail');

  const lost = restoreRound(state, { ids: ['t4', 't2'], indexId: 'gone' });
  assert.equal(lost, null, 'a missing current track means a fresh round');
});
