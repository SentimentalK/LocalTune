import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  windowCapacity,
  shouldVirtualize,
  computeWindow,
} from '../src/ui/virtualList.js';

/** Every window must preserve the full scroll height of the list. */
function assertHeight(node, { count, stride }) {
  assert.equal(
    node.padTop + (node.end - node.start) * stride + node.padBottom,
    count * stride,
  );
}

test('computeWindow returns an empty window for an empty or invalid list', () => {
  const empty = { start: 0, end: 0, padTop: 0, padBottom: 0 };
  assert.deepEqual(
    computeWindow({ count: 0, stride: 66, viewportTop: 0, viewportHeight: 600 }),
    empty,
  );
  assert.deepEqual(
    computeWindow({ count: 100, stride: 0, viewportTop: 0, viewportHeight: 600 }),
    empty,
  );
  assert.deepEqual(
    computeWindow({ count: 100, stride: -66, viewportTop: 0, viewportHeight: 600 }),
    empty,
  );
  assert.deepEqual(
    computeWindow({ count: 100, stride: 66, viewportTop: 0, viewportHeight: Number.NaN }),
    empty,
  );
});

test('computeWindow keeps a single row whole at any viewport offset', () => {
  const atTop = computeWindow({ count: 1, stride: 66, viewportTop: 0, viewportHeight: 600 });
  assert.deepEqual(atTop, { start: 0, end: 1, padTop: 0, padBottom: 0 });
  assertHeight(atTop, { count: 1, stride: 66 });

  const scrolled = computeWindow({ count: 1, stride: 66, viewportTop: 300, viewportHeight: 600 });
  assert.deepEqual(scrolled, { start: 0, end: 1, padTop: 0, padBottom: 0 });
});

test('computeWindow selects the visible middle slice plus one screen of overscan', () => {
  const node = computeWindow({ count: 1000, stride: 66, viewportTop: 3000, viewportHeight: 600 });
  assert.deepEqual(node, { start: 36, end: 64, padTop: 2376, padBottom: 61776 });
  assertHeight(node, { count: 1000, stride: 66 });

  const wider = computeWindow({
    count: 1000,
    stride: 66,
    viewportTop: 3000,
    viewportHeight: 600,
    overscanScreens: 2,
  });
  assert.deepEqual(wider, { start: 27, end: 73, padTop: 1782, padBottom: 61182 });
  assertHeight(wider, { count: 1000, stride: 66 });

  const tight = computeWindow({
    count: 1000,
    stride: 66,
    viewportTop: 3000,
    viewportHeight: 600,
    overscanScreens: 0,
  });
  assert.deepEqual(tight, { start: 45, end: 55, padTop: 2970, padBottom: 62370 });
  assertHeight(tight, { count: 1000, stride: 66 });
});

test('computeWindow clamps at the top of the list', () => {
  const node = computeWindow({ count: 1000, stride: 66, viewportTop: 0, viewportHeight: 600 });
  assert.deepEqual(node, { start: 0, end: 19, padTop: 0, padBottom: 64746 });
  assertHeight(node, { count: 1000, stride: 66 });
});

test('computeWindow clamps past the bottom of the list', () => {
  const node = computeWindow({ count: 1000, stride: 66, viewportTop: 1e9, viewportHeight: 600 });
  assert.deepEqual(node, { start: 1000, end: 1000, padTop: 66000, padBottom: 0 });
  assertHeight(node, { count: 1000, stride: 66 });
});

test('computeWindow renders nothing while the list sits below the viewport', () => {
  const node = computeWindow({ count: 1000, stride: 66, viewportTop: -5000, viewportHeight: 600 });
  assert.deepEqual(node, { start: 0, end: 0, padTop: 0, padBottom: 66000 });
  assertHeight(node, { count: 1000, stride: 66 });
});

test('windowCapacity rounds up and follows the overscan factor', () => {
  assert.equal(windowCapacity({ viewportHeight: 100, stride: 66 }), 5);
  assert.equal(windowCapacity({ viewportHeight: 100, stride: 66, overscanScreens: 0 }), 2);
  assert.equal(windowCapacity({ viewportHeight: 100, stride: 66, overscanScreens: 2 }), 8);
  assert.equal(windowCapacity({ viewportHeight: 844, stride: 62 }), 41);
  assert.equal(windowCapacity({ viewportHeight: 0, stride: 66 }), 0);
  assert.equal(windowCapacity({ viewportHeight: 600, stride: 0 }), 0);
  assert.equal(windowCapacity({ viewportHeight: 600, stride: Number.NaN }), 0);
});

test('shouldVirtualize keeps short lists on the whole-render path', () => {
  // 390x844 page mode: capacity 41, so 2 * 41 = 82 is the crossover.
  const mobile = { viewportHeight: 844, stride: 62 };
  assert.equal(shouldVirtualize({ count: 59, ...mobile }), false);
  assert.equal(shouldVirtualize({ count: 85, ...mobile }), true);
  assert.equal(shouldVirtualize({ count: 82, ...mobile }), false);
  assert.equal(shouldVirtualize({ count: 83, ...mobile }), true);

  const desktop = { viewportHeight: 600, stride: 66 };
  assert.equal(shouldVirtualize({ count: 56, ...desktop }), false);
  assert.equal(shouldVirtualize({ count: 1000, ...desktop }), true);

  assert.equal(shouldVirtualize({ count: 0, ...mobile }), false);
  assert.equal(shouldVirtualize({ count: 1, ...mobile }), false);
  assert.equal(shouldVirtualize({ count: 2, ...mobile }), false);
  assert.equal(shouldVirtualize({ count: -5, ...mobile }), false);
});

test('shouldVirtualize stays off when the viewport or stride is unusable', () => {
  assert.equal(shouldVirtualize({ count: 1000, viewportHeight: 0, stride: 66 }), false);
  assert.equal(shouldVirtualize({ count: 1000, viewportHeight: 600, stride: 0 }), false);
  assert.equal(shouldVirtualize({ count: 1000, viewportHeight: Number.NaN, stride: 66 }), false);
});

test('computeWindow height invariant holds across scroll positions', () => {
  const count = 137;
  const stride = 64.5;
  for (let viewportTop = -1000; viewportTop <= count * stride + 1000; viewportTop += 137) {
    const node = computeWindow({ count, stride, viewportTop, viewportHeight: 600 });
    assertHeight(node, { count, stride });
    assert.ok(node.start >= 0 && node.start <= count);
    assert.ok(node.end >= node.start && node.end <= count);
  }
});
