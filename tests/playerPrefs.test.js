import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PREFS, load, save } from '../src/core/playerPrefs.js';

const KEY = 'localtune.playerPrefs';

/** Minimal Web Storage stand-in; tests never touch the real localStorage. */
function createStorage(initial = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    getItem: (key) => (rows.has(key) ? rows.get(key) : null),
    setItem: (key, value) => rows.set(key, String(value)),
    rows,
  };
}

test('save then load round-trips shuffle and repeat', () => {
  const storage = createStorage();
  save({ shuffle: true, repeat: 'one' }, storage);

  assert.equal(storage.rows.get(KEY), JSON.stringify({ shuffle: true, repeat: 'one' }));
  assert.deepEqual(load(storage), { shuffle: true, repeat: 'one' });
});

test('load returns null when nothing was stored', () => {
  assert.equal(load(createStorage()), null);
});

test('broken JSON falls back to the default prefs', () => {
  assert.deepEqual(load(createStorage({ [KEY]: '{not json' })), { ...DEFAULT_PREFS });
});

test('non-object JSON falls back to the default prefs', () => {
  for (const raw of ['[]', '[1,2]', '3', '"all"', 'null', 'true']) {
    assert.deepEqual(load(createStorage({ [KEY]: raw })), { ...DEFAULT_PREFS }, raw);
  }
});

test('unknown values are sanitised', () => {
  const storage = createStorage({ [KEY]: JSON.stringify({ shuffle: 'yes', repeat: 'loop' }) });
  assert.deepEqual(load(storage), { shuffle: false, repeat: 'off' });

  save({ shuffle: 'yes', repeat: 'loop' }, storage);
  assert.equal(storage.rows.get(KEY), JSON.stringify({ shuffle: false, repeat: 'off' }));
});

test('a storage that throws never breaks load or save', () => {
  const storage = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('full');
    },
  };

  assert.deepEqual(load(storage), { ...DEFAULT_PREFS });
  assert.doesNotThrow(() => save({ shuffle: true, repeat: 'all' }, storage));
});
