import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ONBOARDING_KEY,
  ONBOARDING_STEPS,
  ONBOARDING_VERSION,
  arrowGeometry,
  chalkArrowPath,
  clearOnboarded,
  isOnboarded,
  markOnboarded,
  shouldShowOnboarding,
} from '../src/ui/onboarding.js';

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

test('the guide has four ordered steps, each pointing somewhere unique', () => {
  assert.equal(ONBOARDING_STEPS.length, 4);
  assert.deepEqual(
    ONBOARDING_STEPS.map((step) => step.id),
    ['play', 'seek', 'tabs', 'search'],
  );
  for (const step of ONBOARDING_STEPS) {
    assert.ok(step.target.trim().length > 0, `${step.id} target`);
    assert.ok(step.textKey.trim().length > 0, `${step.id} textKey`);
    assert.ok(step.side.trim().length > 0, `${step.id} side`);
  }
  assert.equal(new Set(ONBOARDING_STEPS.map((step) => step.target)).size, 4);
  assert.equal(new Set(ONBOARDING_STEPS.map((step) => step.textKey)).size, 4);
});

test('the completion mark is a versioned key', () => {
  const storage = fakeStorage();

  assert.equal(isOnboarded(storage), false);
  markOnboarded(storage);
  assert.equal(isOnboarded(storage), true);
  assert.equal(storage.getItem(ONBOARDING_KEY), ONBOARDING_VERSION);
  assert.equal(ONBOARDING_VERSION, 'v1');

  clearOnboarded(storage);
  assert.equal(isOnboarded(storage), false);

  // An older version of the guide does not count as seen.
  storage.setItem(ONBOARDING_KEY, 'v0');
  assert.equal(isOnboarded(storage), false);
});

test('shouldShowOnboarding only fires for a first run with tracks', () => {
  const fresh = fakeStorage();
  const seen = fakeStorage();
  markOnboarded(seen);

  assert.equal(shouldShowOnboarding({ storage: fresh, hasTracks: true }), true);
  assert.equal(shouldShowOnboarding({ storage: fresh, hasTracks: false }), false);
  assert.equal(shouldShowOnboarding({ storage: seen, hasTracks: true }), false);
  assert.equal(
    shouldShowOnboarding({ storage: fresh, hasTracks: true, automated: true }),
    false,
  );
  assert.equal(
    shouldShowOnboarding({ storage: fresh, hasTracks: true, automated: true, force: true }),
    true,
  );
  assert.equal(
    shouldShowOnboarding({ storage: seen, hasTracks: true, automated: false, force: true }),
    false,
  );
});

test('the arrow ends on the target centre and starts on the requested side', () => {
  const target = { x: 500, y: 300, width: 200, height: 100 };
  const viewport = { width: 1280, height: 800 };

  for (const side of ['below', 'above', 'left', 'right']) {
    const geometry = arrowGeometry({ target, viewport, side });
    assert.deepEqual(geometry.end, { x: 600, y: 350 }, `${side} end`);
    if (side === 'below') assert.ok(geometry.start.y > geometry.end.y, 'below');
    if (side === 'above') assert.ok(geometry.start.y < geometry.end.y, 'above');
    if (side === 'left') assert.ok(geometry.start.x < geometry.end.x, 'left');
    if (side === 'right') assert.ok(geometry.start.x > geometry.end.x, 'right');
    for (const axis of ['x', 'y']) {
      const limit = axis === 'x' ? viewport.width : viewport.height;
      assert.ok(geometry.start[axis] >= 24, `${side} ${axis} low`);
      assert.ok(geometry.start[axis] <= limit - 24, `${side} ${axis} high`);
    }
    assert.ok(Number.isFinite(geometry.control.x));
    assert.ok(Number.isFinite(geometry.control.y));
  }

  // A target hugging the top-left corner still keeps the tail inside the frame.
  const cornered = arrowGeometry({
    target: { x: 0, y: 0, width: 20, height: 20 },
    viewport,
    side: 'above',
  });
  assert.equal(cornered.start.y, 24);
  assert.equal(cornered.start.x, 24);
});

test('the chalk path is deterministic and lands exactly on the tip', () => {
  const geometry = arrowGeometry({
    target: { x: 500, y: 300, width: 200, height: 100 },
    viewport: { width: 1280, height: 800 },
    side: 'below',
  });

  const first = chalkArrowPath(geometry, 7);
  assert.equal(chalkArrowPath(geometry, 7), first);
  assert.notEqual(chalkArrowPath(geometry, 8), first);

  const numbers = first.match(/-?\d+(?:\.\d+)?/g).map(Number);
  assert.equal(numbers.at(-2), geometry.end.x);
  assert.equal(numbers.at(-1), geometry.end.y);
  assert.ok(numbers.length > 8);
  assert.ok(first.startsWith('M'));
});
