import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GDRIVE_BETA_ACK_VALUE, loadGdriveBetaAck, saveGdriveBetaAck } from '../src/ui/uiPrefs.js';

const KEY = 'localtune:gdriveBetaAck';

/** Minimal Web Storage stand-in; tests never touch the real localStorage. */
function createStorage(initial = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    getItem: (key) => (rows.has(key) ? rows.get(key) : null),
    setItem: (key, value) => rows.set(key, String(value)),
    rows,
  };
}

test('the beta ack is absent until saved, then stays for this version', () => {
  const storage = createStorage();
  assert.equal(loadGdriveBetaAck(storage), false);

  saveGdriveBetaAck(storage);
  assert.equal(storage.rows.get(KEY), GDRIVE_BETA_ACK_VALUE);
  assert.equal(loadGdriveBetaAck(storage), true);
});

test('a stale ack value does not count as accepted', () => {
  assert.equal(loadGdriveBetaAck(createStorage({ [KEY]: 'v0' })), false);
});

test('a storage that throws never breaks the ack check or the save', () => {
  const blocked = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('full');
    },
  };
  assert.equal(loadGdriveBetaAck(blocked), false);
  assert.doesNotThrow(() => saveGdriveBetaAck(blocked));
});
