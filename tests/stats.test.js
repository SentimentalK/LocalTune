import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PLAY_COUNT_SECONDS,
  thresholdSeconds,
  shouldCount,
  createPlayCounter,
  applyPlay,
  ensureAdded,
  recentlyAdded,
  mostPlayed,
  neverPlayed,
} from '../src/core/stats.js';

function track(id, duration = 120, extra = {}) {
  return { id, path: `${id}.mp3`, duration, mtime: 1000, ...extra };
}

function plainTrack(id, extra = {}) {
  return { id, path: `${id}.mp3`, ...extra };
}

test('thresholdSeconds uses 30 s or half the duration, whichever is shorter', () => {
  assert.equal(PLAY_COUNT_SECONDS, 30);
  assert.equal(thresholdSeconds(0), 30);
  assert.equal(thresholdSeconds(20), 10);
  assert.equal(thresholdSeconds(120), 30);
});

test('shouldCount compares accumulated listening against the threshold', () => {
  assert.equal(shouldCount(9.5, 20), false);
  assert.equal(shouldCount(10, 20), true);
  assert.equal(shouldCount(0, 0), false);
});

test('a 20 s track below 10 s listened does not count', () => {
  const counter = createPlayCounter();
  counter.start(track('short', 20));
  assert.equal(counter.trackId, 'short');

  counter.update(5);
  counter.update(9.9);
  assert.ok(Math.abs(counter.listened - 9.9) < 1e-9);
  assert.equal(counter.counted, false);
});

test('a 20 s track counts exactly once at 10 s listened', () => {
  const counter = createPlayCounter();
  counter.start(track('short', 20));

  assert.deepEqual(counter.update(5), { justCounted: false });
  assert.deepEqual(counter.update(10), { justCounted: true });
  assert.equal(counter.listened, 10);
  assert.equal(counter.counted, true);

  assert.deepEqual(counter.update(15), { justCounted: false });
  assert.equal(counter.counted, true);
});

test('a 120 s track needs the full 30 s before the play counts', () => {
  const counter = createPlayCounter();
  counter.start(track('long', 120));

  for (const position of [5, 10, 15, 20, 25, 29.5]) counter.update(position);
  assert.equal(counter.listened, 29.5);
  assert.equal(counter.counted, false);

  assert.deepEqual(counter.update(30), { justCounted: true });
  assert.equal(counter.listened, 30);
});

test('a forward jump larger than 5 s is a seek and adds nothing', () => {
  const counter = createPlayCounter();
  counter.start(track('seek', 120), 0);

  assert.deepEqual(counter.update(20), { justCounted: false });
  assert.equal(counter.listened, 0);

  counter.update(25);
  assert.equal(counter.listened, 5);
});

test('after a backward seek, counting resumes from the new position', () => {
  const counter = createPlayCounter();
  counter.start(track('back', 120), 30);

  counter.update(10);
  assert.equal(counter.listened, 0);

  counter.update(15);
  assert.equal(counter.listened, 5);
});

test('pause and resume keep the accumulated time without double counting', () => {
  const counter = createPlayCounter();
  counter.start(track('paused', 120));
  counter.update(5);
  counter.pause();
  counter.update(50);
  assert.equal(counter.listened, 5);

  counter.resume(50);
  counter.update(55);
  assert.equal(counter.listened, 10);

  counter.update(60);
  assert.equal(counter.listened, 15);
});

test('listened time never grows past the track duration', () => {
  const counter = createPlayCounter();
  counter.start(track('cap', 12));
  for (const position of [5, 10, 11, 12, 13]) counter.update(position);
  assert.equal(counter.listened, 12);
  assert.equal(counter.counted, true);
});

test('applyPlay increments plays while keeping addedAt and updating lastPlayedAt', () => {
  const stats = { a: { plays: 1, lastPlayedAt: 10, addedAt: 5 } };
  const next = applyPlay(stats, { id: 'a', now: 99 });

  assert.notEqual(next, stats);
  assert.deepEqual(next.a, { plays: 2, lastPlayedAt: 99, addedAt: 5 });
  assert.deepEqual(stats, { a: { plays: 1, lastPlayedAt: 10, addedAt: 5 } });
});

test('applyPlay seeds a row from the play itself', () => {
  const next = applyPlay({}, { id: 'b', now: 7 });
  assert.deepEqual(next.b, { plays: 1, lastPlayedAt: 7, addedAt: 7 });
});

test('ensureAdded fills only missing rows and reports them', () => {
  const tracks = [track('a'), { ...track('b'), mtime: 222 }];
  const existing = { a: { plays: 3, lastPlayedAt: 50, addedAt: 40 } };

  const first = ensureAdded(existing, tracks, { now: 999 });
  assert.deepEqual(first.added, ['b']);
  assert.equal(first.stats.a, existing.a);
  assert.deepEqual(first.stats.b, { plays: 0, lastPlayedAt: null, addedAt: 222 });

  const second = ensureAdded(first.stats, tracks, { now: 1000 });
  assert.deepEqual(second.added, []);
  assert.deepEqual(second.stats, first.stats);
});

test('ensureAdded falls back to now when a track has no mtime', () => {
  const { stats, added } = ensureAdded({}, [{ id: 'c', path: 'c.mp3', mtime: 0 }], { now: 4242 });
  assert.deepEqual(added, ['c']);
  assert.equal(stats.c.addedAt, 4242);
});

test('recentlyAdded sorts by addedAt desc, path asc, and honours the limit', () => {
  const tracks = [plainTrack('a'), plainTrack('b'), plainTrack('c'), plainTrack('d')];
  const stats = {
    a: { addedAt: 10 },
    b: { addedAt: 30 },
    c: { addedAt: 30 },
  };

  assert.deepEqual(
    recentlyAdded(tracks, stats).map((item) => item.id),
    ['b', 'c', 'a', 'd'],
  );
  assert.deepEqual(
    recentlyAdded(tracks, stats, 2).map((item) => item.id),
    ['b', 'c'],
  );
});

test('mostPlayed keeps only played tracks and breaks ties deterministically', () => {
  const tracks = [plainTrack('a'), plainTrack('b'), plainTrack('e'), plainTrack('c'), plainTrack('d'), plainTrack('z')];
  const stats = {
    a: { plays: 2, lastPlayedAt: 10 },
    b: { plays: 2, lastPlayedAt: 20 },
    e: { plays: 2, lastPlayedAt: 20 },
    c: { plays: 1, lastPlayedAt: 99 },
    d: { plays: 0, lastPlayedAt: null },
  };

  assert.deepEqual(
    mostPlayed(tracks, stats).map((item) => item.id),
    ['b', 'e', 'a', 'c'],
  );
  assert.deepEqual(
    mostPlayed(tracks, stats, 2).map((item) => item.id),
    ['b', 'e'],
  );
});

test('mostPlayed returns nothing when nothing has been played', () => {
  const tracks = [plainTrack('a'), plainTrack('b')];
  assert.deepEqual(mostPlayed(tracks, {}), []);
  assert.deepEqual(mostPlayed(tracks, { a: { plays: 0 }, b: { plays: 0 } }), []);
});

test('neverPlayed includes tracks without a stats row, sorted by path', () => {
  const tracks = [plainTrack('z'), plainTrack('a'), plainTrack('c')];
  const stats = { a: { plays: 0 }, c: { plays: 4 } };

  assert.deepEqual(
    neverPlayed(tracks, stats).map((item) => item.id),
    ['a', 'z'],
  );
});
