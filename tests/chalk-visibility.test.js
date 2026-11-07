import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldShowChalk } from '../src/ui/chalkLayer.js';

test('the chalk hint shows only with a queued demo and a paused deck', () => {
  assert.equal(shouldShowChalk({ hasDemo: true, playing: false }), true);
  assert.equal(shouldShowChalk({ hasDemo: true, playing: true }), false);
  assert.equal(shouldShowChalk({ hasDemo: false, playing: false }), false);
  assert.equal(shouldShowChalk({ hasDemo: false, playing: true }), false);
});
