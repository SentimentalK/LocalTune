import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyInstall } from '../src/core/install.js';

test('classifyInstall covers every display mode, prompt and installed flag', () => {
  const modes = ['browser', 'standalone', 'fullscreen', 'minimal-ui', 'tabbed'];
  const installedModes = new Set(['standalone', 'fullscreen', 'minimal-ui']);

  for (const displayMode of modes) {
    for (const canPrompt of [false, true]) {
      for (const installed of [false, true]) {
        const expected =
          installed || installedModes.has(displayMode)
            ? 'installed'
            : canPrompt
              ? 'installable'
              : 'browser';
        assert.equal(
          classifyInstall({ displayMode, canPrompt, installed }),
          expected,
          `displayMode=${displayMode} canPrompt=${canPrompt} installed=${installed}`,
        );
      }
    }
  }
});

test('classifyInstall defaults to browser', () => {
  assert.equal(classifyInstall(), 'browser');
  assert.equal(classifyInstall({}), 'browser');
  assert.equal(classifyInstall({ canPrompt: true }), 'installable');
});
