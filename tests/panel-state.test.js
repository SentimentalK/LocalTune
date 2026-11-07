import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  derivePanelState,
  panelAfterClose,
  panelAfterToggle,
} from '../src/ui/app.js';

const VIEWS = ['vip', 'settings', 'library'];

function closeKeys(state) {
  const keys = derivePanelState(state);
  return VIEWS.filter((view) => keys[view].icon === 'close');
}

// --- derivePanelState ----------------------------------------------------

test('derivePanelState shows every own glyph while the panel is closed', () => {
  const keys = derivePanelState({ panelView: 'library', panelOpen: false });

  assert.deepEqual(keys.library, { icon: 'own', expanded: false, label: 'aria.library' });
  assert.deepEqual(keys.vip, { icon: 'own', expanded: false, label: 'vip.open' });
  assert.deepEqual(keys.settings, { icon: 'own', expanded: false, label: 'settings.open' });
});

test('derivePanelState gives the open settings view the only close glyph', () => {
  const keys = derivePanelState({ panelView: 'settings', panelOpen: true });

  assert.deepEqual(keys.settings, { icon: 'close', expanded: true, label: 'panel.close' });
  assert.deepEqual(keys.vip, { icon: 'own', expanded: false, label: 'vip.open' });
  assert.deepEqual(keys.library, { icon: 'own', expanded: false, label: 'aria.library' });
});

test('derivePanelState gives the open library view the only close glyph', () => {
  const keys = derivePanelState({ panelView: 'library', panelOpen: true });

  assert.deepEqual(keys.library, { icon: 'close', expanded: true, label: 'panel.close' });
  assert.deepEqual(keys.vip, { icon: 'own', expanded: false, label: 'vip.open' });
  assert.deepEqual(keys.settings, { icon: 'own', expanded: false, label: 'settings.open' });
});

test('derivePanelState ignores a non-true panelOpen', () => {
  const keys = derivePanelState({ panelView: 'vip', panelOpen: '1' });

  assert.deepEqual(keys.vip, { icon: 'own', expanded: false, label: 'vip.open' });
});

// --- desktop toggle sequence --------------------------------------------

function desktopSequence() {
  let state = { panelView: 'library', panelOpen: false };
  const steps = [];
  for (const view of ['vip', 'settings', 'settings', 'library']) {
    state = panelAfterToggle(state, view, false);
    steps.push(state);
  }
  return steps;
}

test('desktop toggles move the single close glyph and close back to the library', () => {
  const steps = desktopSequence();

  assert.deepEqual(steps[0], { panelView: 'vip', panelOpen: true });
  assert.deepEqual(steps[1], { panelView: 'settings', panelOpen: true });
  assert.deepEqual(steps[2], { panelView: 'library', panelOpen: true });
  assert.deepEqual(steps[3], { panelView: 'library', panelOpen: false });

  assert.deepEqual(steps.map((state) => closeKeys(state).length), [1, 1, 1, 0]);
  assert.deepEqual(closeKeys(steps[1]), ['settings']);
  assert.deepEqual(closeKeys(steps[2]), ['library']);
  assert.deepEqual(closeKeys(steps[3]), []);
  assert.deepEqual(derivePanelState(steps[1]).vip.icon, 'own');
});

test('desktop reopening a view after the sequence keeps a single close glyph', () => {
  const reopened = panelAfterToggle({ panelView: 'library', panelOpen: false }, 'vip', false);

  assert.deepEqual(reopened, { panelView: 'vip', panelOpen: true });
  assert.deepEqual(closeKeys(reopened), ['vip']);
});

// --- mobile toggle sequence ---------------------------------------------

test('mobile re-clicking settings closes the overlay to the plain library', () => {
  let state = { panelView: 'library', panelOpen: false };
  const steps = [];
  for (const view of ['vip', 'settings', 'settings', 'library']) {
    state = panelAfterToggle(state, view, true);
    steps.push(state);
  }

  assert.deepEqual(steps[0], { panelView: 'vip', panelOpen: true });
  assert.deepEqual(steps[1], { panelView: 'settings', panelOpen: true });
  assert.deepEqual(steps[2], { panelView: 'library', panelOpen: false });
  assert.deepEqual(steps[3], { panelView: 'library', panelOpen: false });
  assert.deepEqual(steps.map((state) => closeKeys(state).length), [1, 1, 0, 0]);
});

test('mobile library toggle collapses instead of opening the panel', () => {
  assert.deepEqual(panelAfterToggle({ panelView: 'settings', panelOpen: true }, 'library', true), {
    panelView: 'library',
    panelOpen: false,
  });
});

// --- panelAfterClose ----------------------------------------------------

test('panelAfterClose lands on the library view and keeps it open on desktop only', () => {
  assert.deepEqual(panelAfterClose({ panelView: 'settings', panelOpen: true }, false), {
    panelView: 'library',
    panelOpen: true,
  });
  assert.deepEqual(panelAfterClose({ panelView: 'library', panelOpen: true }, false), {
    panelView: 'library',
    panelOpen: false,
  });
  assert.deepEqual(panelAfterClose({ panelView: 'settings', panelOpen: true }, true), {
    panelView: 'library',
    panelOpen: false,
  });
});
