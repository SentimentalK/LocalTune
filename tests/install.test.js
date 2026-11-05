import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyInstall, initInstall } from '../src/core/install.js';

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

function fakeWindow() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    dispatch(type, event) {
      listeners.get(type)?.(event);
    },
    matchMedia: () => ({ matches: false }),
  };
}

function promptEvent(outcome) {
  return {
    preventDefault() {},
    async prompt() {},
    userChoice: Promise.resolve({ outcome }),
  };
}

test('an accepted install prompt marks the app installed for this session', async () => {
  const win = fakeWindow();
  const install = initInstall({ window: win });
  win.dispatch('beforeinstallprompt', promptEvent('accepted'));
  assert.equal(install.state().status, 'installable');
  assert.equal((await install.prompt()).outcome, 'accepted');
  assert.equal(install.state().status, 'installed');
});

test('a dismissed install prompt keeps the environment state', async () => {
  const win = fakeWindow();
  const install = initInstall({ window: win });
  win.dispatch('beforeinstallprompt', promptEvent('dismissed'));
  assert.equal((await install.prompt()).outcome, 'dismissed');
  assert.equal(install.state().status, 'browser');
  assert.equal(install.state().canPrompt, false);
});
