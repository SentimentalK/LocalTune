import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  libraryVisible,
  sourceNeedsReconnect,
  sourceVisible,
  visibleSources,
} from '../src/core/library.js';

const row = (permission, trackCount) => ({ id: 'onedrive', permission, trackCount });

test('sourceVisible keeps granted sources and any source that still owns tracks', () => {
  assert.equal(sourceVisible(row('granted', 0)), true);
  assert.equal(sourceVisible(row('prompt', 3)), true);
  assert.equal(sourceVisible(row('none', 0)), false);
  assert.equal(sourceVisible(undefined), false);
  assert.equal(sourceVisible({ id: 'onedrive', permission: 'prompt' }), false);
  assert.equal(sourceVisible({ id: 'onedrive', permission: 'prompt', trackCount: 1 }), true);
});

test('visibleSources filters in place and preserves the input order', () => {
  const local = { id: 'local', permission: 'none', trackCount: 0 };
  const cloud = { id: 'onedrive', permission: 'prompt', trackCount: 2 };
  const granted = { id: 'opfs', permission: 'granted', trackCount: 0 };

  assert.deepEqual(visibleSources([local, cloud, granted]), [cloud, granted]);
  assert.deepEqual(visibleSources([cloud, local]), [cloud]);
  assert.deepEqual(visibleSources(undefined), []);
  assert.deepEqual(visibleSources([]), []);
});

test('sourceNeedsReconnect covers expired grants with cached tracks only', () => {
  assert.equal(sourceNeedsReconnect(row('prompt', 3)), true);
  assert.equal(sourceNeedsReconnect(row('none', 3)), true);
  assert.equal(sourceNeedsReconnect(row('granted', 3)), false);
  assert.equal(sourceNeedsReconnect(row('prompt', 0)), false);
  assert.equal(sourceNeedsReconnect(null), false);
});

test('libraryVisible needs either tracks or a visible source', () => {
  const none = { id: 'onedrive', permission: 'none', trackCount: 0 };
  const granted = { id: 'onedrive', permission: 'granted', trackCount: 0 };
  const prompt = { id: 'onedrive', permission: 'prompt', trackCount: 2 };

  assert.equal(libraryVisible({ tracks: [], sources: [none] }), false);
  assert.equal(libraryVisible({ tracks: [], sources: [granted] }), true);
  assert.equal(libraryVisible({ tracks: [{ id: 'a' }], sources: [prompt] }), true);
  assert.equal(libraryVisible({ tracks: [], sources: [] }), false);
  assert.equal(libraryVisible({}), false);
});
