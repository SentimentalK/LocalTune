import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupByFolder } from '../src/core/folders.js';

function track(id, path, trackNo = null) {
  return { id, path, trackNo };
}

function ids(entry) {
  return entry.trackIds;
}

test('groupByFolder counts nested tracks in every ancestor directory', () => {
  const tracks = [
    track('root', '0.mp3'),
    track('a1', 'A/1.mp3'),
    track('b2', 'A/B/2.mp3'),
    track('b3', 'A/B/3.mp3'),
  ];

  const groups = groupByFolder(tracks);

  assert.deepEqual(
    groups.map((group) => [group.dir, group.count]),
    [
      ['', 1],
      ['A', 3],
      ['A/B', 2],
    ],
  );
  assert.deepEqual(ids(groups[0]), ['root']);
  assert.deepEqual(ids(groups[1]), ['a1', 'b2', 'b3']);
  assert.deepEqual(ids(groups[2]), ['b2', 'b3']);
});

test('groupByFolder orders tracks by trackNo first, then naturally by name', () => {
  const tracks = [
    track('ten', 'A/10.mp3'),
    track('two', 'A/2.mp3'),
    track('one', 'A/01.mp3', 1),
    track('three', 'A/03.mp3', 3),
  ];

  const [group] = groupByFolder(tracks);

  assert.deepEqual(ids(group), ['one', 'three', 'two', 'ten']);
});

test('groupByFolder sorts directories ascending by relative path', () => {
  const tracks = [
    track('b', 'B/1.mp3'),
    track('ac', 'A/C/1.mp3'),
    track('a', 'A/1.mp3'),
  ];

  const groups = groupByFolder(tracks);

  assert.deepEqual(
    groups.map((group) => group.dir),
    ['A', 'A/C', 'B'],
  );
});

test('root-directory tracks stay in the root group only', () => {
  const tracks = [track('root1', '1.mp3'), track('root2', '2.mp3'), track('nested', 'A/1.mp3')];

  const groups = groupByFolder(tracks);

  assert.deepEqual(
    groups.map((group) => [group.dir, group.count]),
    [
      ['', 2],
      ['A', 1],
    ],
  );
  assert.deepEqual(ids(groups[0]), ['root1', 'root2']);
});

test('groupByFolder returns an empty list for empty input', () => {
  assert.deepEqual(groupByFolder(), []);
  assert.deepEqual(groupByFolder([]), []);
});

test('tracks without a path fall back to the root directory', () => {
  const groups = groupByFolder([{ id: 'noPath' }, { id: 'p', path: 'A/1.mp3' }]);

  assert.deepEqual(
    groups.map((group) => [group.dir, group.count]),
    [
      ['', 1],
      ['A', 1],
    ],
  );
  assert.deepEqual(ids(groups[0]), ['noPath']);
});

test('groupByFolder does not mutate its input', () => {
  const tracks = [track('two', 'A/2.mp3'), track('one', 'A/1.mp3')];
  const snapshot = tracks.map((item) => item.id);

  groupByFolder(tracks);

  assert.deepEqual(
    tracks.map((item) => item.id),
    snapshot,
  );
});
