import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subdirsOf, tracksDirect, tracksUnder } from '../src/core/folders.js';

function track(id, path, trackNo = null) {
  return { id, path, trackNo };
}

const NESTED = [
  track('root', '0.mp3'),
  track('a1', 'A/1.mp3'),
  track('b2', 'A/B/2.mp3'),
  track('b3', 'A/B/3.mp3'),
  track('c1', 'A/B/C/1.mp3'),
];

const ids = (tracks) => tracks.map((item) => item.id);

test('subdirsOf counts nested tracks in every direct child', () => {
  const subs = subdirsOf(NESTED);

  assert.deepEqual(
    subs.map((entry) => [entry.dir, entry.name, entry.count]),
    [['A', 'A', 4]],
  );

  const inner = subdirsOf(NESTED, 'A');
  assert.deepEqual(
    inner.map((entry) => [entry.dir, entry.name, entry.count]),
    [['A/B', 'B', 3]],
  );
  assert.deepEqual(
    subdirsOf(NESTED, 'A/B').map((entry) => [entry.dir, entry.count]),
    [['A/B/C', 1]],
  );
  assert.deepEqual(subdirsOf(NESTED, 'A/B/C'), []);
});

test('subdirsOf lists only direct children, never grandchildren', () => {
  const tracks = [track('x', 'Music/x.mp3'), track('y', 'Music/Sub/y.mp3')];

  assert.deepEqual(
    subdirsOf(tracks).map((entry) => entry.dir),
    ['Music'],
  );
  assert.deepEqual(
    subdirsOf(tracks, 'Music').map((entry) => entry.dir),
    ['Music/Sub'],
  );
});

test('tracksDirect keeps only this directory, tracksUnder keeps the subtree', () => {
  assert.deepEqual(ids(tracksDirect(NESTED, 'A')), ['a1']);
  assert.deepEqual(ids(tracksDirect(NESTED, 'A/B')), ['b2', 'b3']);
  assert.deepEqual(ids(tracksUnder(NESTED, 'A')), ['a1', 'c1', 'b2', 'b3']);
  assert.deepEqual(ids(tracksUnder(NESTED, 'A/B')), ['c1', 'b2', 'b3']);
});

test('tracksUnder with an empty dir returns the whole library', () => {
  assert.deepEqual(ids(tracksUnder(NESTED, '')), ['root', 'a1', 'c1', 'b2', 'b3']);
  assert.deepEqual(ids(tracksDirect(NESTED, '')), ['root']);
  assert.deepEqual(tracksUnder([]), []);
  assert.deepEqual(tracksDirect([]), []);
  assert.deepEqual(subdirsOf([]), []);
});

test('a sibling directory with a common prefix is not part of the subtree', () => {
  const tracks = [track('a', 'A/1.mp3'), track('ab', 'AB/1.mp3')];

  assert.deepEqual(ids(tracksUnder(tracks, 'A')), ['a']);
  assert.deepEqual(
    subdirsOf(tracks).map((entry) => entry.dir),
    ['A', 'AB'],
  );
});

test('tracks without a path count as root-directory tracks', () => {
  const tracks = [{ id: 'noPath' }, track('p', 'A/1.mp3')];

  assert.deepEqual(ids(tracksDirect(tracks, '')), ['noPath']);
  assert.deepEqual(ids(tracksUnder(tracks, 'A')), ['p']);
  assert.deepEqual(
    subdirsOf(tracks).map((entry) => entry.dir),
    ['A'],
  );
});

test('ordering is by trackNo, then naturally by file name', () => {
  const tracks = [
    track('ten', 'A/10.mp3'),
    track('two', 'A/2.mp3'),
    track('one', 'A/01.mp3', 1),
    track('three', 'A/03.mp3', 3),
  ];

  assert.deepEqual(ids(tracksDirect(tracks, 'A')), ['one', 'three', 'two', 'ten']);
});

test('subdirectories sort naturally by name', () => {
  const tracks = [
    track('d10', 'A/10/1.mp3'),
    track('d2', 'A/2/1.mp3'),
    track('d1', 'A/1/1.mp3'),
  ];

  assert.deepEqual(
    subdirsOf(tracks, 'A').map((entry) => entry.name),
    ['1', '2', '10'],
  );
});

test('the helpers do not mutate their input', () => {
  const tracks = [track('two', 'A/2.mp3'), track('one', 'A/1.mp3'), track('deep', 'A/B/1.mp3')];
  const snapshot = tracks.map((item) => [item.id, item.path]);

  tracksDirect(tracks, 'A');
  tracksUnder(tracks, 'A');
  subdirsOf(tracks, 'A');

  assert.deepEqual(
    tracks.map((item) => [item.id, item.path]),
    snapshot,
  );
});
