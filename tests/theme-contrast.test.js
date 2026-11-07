import { test } from 'node:test';
import assert from 'node:assert/strict';

import { THEMES, THEME_NAMES } from '../src/ui/uiPrefs.js';
import { MINIMUM, loadAudit } from '../scripts/theme-contrast.mjs';

// The palette is a product surface: a visual tweak must never drop text below
// its reading floor. Failures name the token, so the fix is always a colour
// value, never a "looks fine" judgement.

test('every theme meets its contrast floors', async () => {
  const rows = await loadAudit();
  const failures = rows.flatMap((row) =>
    row.failures.map((failure) => `${row.name}: ${failure}`),
  );
  assert.deepEqual(failures, []);
});

test('the audited themes are exactly the themes the picker offers', async () => {
  const rows = await loadAudit();
  assert.deepEqual(
    rows.map((row) => row.name).sort(),
    [...THEMES].sort(),
  );
});

test('every offered theme has a display name', () => {
  for (const theme of THEMES) {
    assert.equal(typeof THEME_NAMES[theme], 'string', theme);
    assert.ok(THEME_NAMES[theme].trim().length > 0, theme);
  }
});

test('contrast maths matches the WCAG reference pairs', async () => {
  const { contrast } = await import('../scripts/theme-contrast.mjs');
  assert.equal(contrast('#000000', '#ffffff'), 21);
  assert.equal(contrast('#ffffff', '#000000'), 21);
  assert.ok(Math.abs(contrast('#777777', '#ffffff') - 4.478) < 0.01);
  // Order does not matter: the lighter colour is always the numerator.
  assert.equal(contrast('#9eacb3', '#101921'), contrast('#101921', '#9eacb3'));
});

test('the floors are the documented ones', () => {
  assert.deepEqual(MINIMUM, {
    text: 7,
    dim: 4.5,
    muted: 3,
    accent: 3,
    warn: 3,
    danger: 3,
    ink_bg: 4.5,
    ink_bg2: 4.5,
  });
});
