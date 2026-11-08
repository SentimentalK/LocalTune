import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldShowChalk } from '../src/ui/chalkLayer.js';

test('the chalk hint shows only with a queued demo and a paused deck', () => {
  assert.equal(shouldShowChalk({ hasDemo: true, playing: false }), true);
  assert.equal(shouldShowChalk({ hasDemo: true, playing: true }), false);
  assert.equal(shouldShowChalk({ hasDemo: false, playing: false }), false);
  assert.equal(shouldShowChalk({ hasDemo: false, playing: true }), false);
});

test('the chalk hint hides while a deck gesture is active', () => {
  assert.equal(shouldShowChalk({ hasDemo: true, playing: false, gesture: true }), false);
  assert.equal(shouldShowChalk({ hasDemo: true, playing: false, gesture: false }), true);
  assert.equal(shouldShowChalk({ hasDemo: true, playing: true, gesture: true }), false);
});
