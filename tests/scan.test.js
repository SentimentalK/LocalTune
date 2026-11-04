import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffScan } from '../src/core/scan.js';

function track(path, mtime, size) {
  return { id: `fsa:${path}`, path, mtime, size };
}

function entry(path, mtime, size) {
  return { path, mtime, size };
}

test('identical listings are all unchanged', () => {
  const previous = [track('a.mp3', 100, 10), track('b.mp3', 200, 20)];
  const entries = [entry('a.mp3', 100, 10), entry('b.mp3', 200, 20)];
  const diff = diffScan(previous, entries);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.updated, []);
  assert.deepEqual(diff.removedIds, []);
  assert.equal(diff.unchanged, 2);
});

test('new paths are added, missing paths are removed', () => {
  const previous = [track('keep.mp3', 1, 1), track('gone.mp3', 2, 2)];
  const entries = [entry('keep.mp3', 1, 1), entry('new.mp3', 3, 3)];
  const diff = diffScan(previous, entries);
  assert.deepEqual(diff.added.map((item) => item.path), ['new.mp3']);
  assert.deepEqual(diff.updated, []);
  assert.deepEqual(diff.removedIds, ['fsa:gone.mp3']);
  assert.equal(diff.unchanged, 1);
});

test('mtime change marks a track updated', () => {
  const diff = diffScan([track('a.mp3', 100, 10)], [entry('a.mp3', 101, 10)]);
  assert.deepEqual(diff.updated.map((item) => item.path), ['a.mp3']);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removedIds, []);
  assert.equal(diff.unchanged, 0);
});

test('size change marks a track updated', () => {
  const diff = diffScan([track('a.mp3', 100, 10)], [entry('a.mp3', 100, 11)]);
  assert.deepEqual(diff.updated.map((item) => item.path), ['a.mp3']);
  assert.equal(diff.unchanged, 0);
});

test('empty inputs produce an empty diff', () => {
  assert.deepEqual(diffScan([], []), { added: [], updated: [], removedIds: [], unchanged: 0 });
  assert.deepEqual(diffScan(undefined, undefined), {
    added: [],
    updated: [],
    removedIds: [],
    unchanged: 0,
  });
  assert.deepEqual(diffScan([track('a.mp3', 1, 1)], []), {
    added: [],
    updated: [],
    removedIds: ['fsa:a.mp3'],
    unchanged: 0,
  });
});
