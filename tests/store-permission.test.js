import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/core/store.js';
import { createQueue } from '../src/core/queue.js';

/** In-memory IndexedDB double: one Map per store, microtask completion. */
function fakeDb() {
  const stores = new Map();
  const dataFor = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };
  const request = (compute) => {
    const req = {};
    queueMicrotask(() => {
      try {
        req.result = compute();
        req.onsuccess?.();
      } catch (error) {
        req.error = error;
        req.onerror?.();
      }
    });
    return req;
  };
  return {
    transaction(name) {
      const names = Array.isArray(name) ? name : [name];
      const tx = { error: null };
      tx.objectStore = (storeName) => {
        const data = dataFor(storeName ?? names[0]);
        return {
          getAll: () => request(() => [...data.values()].map((row) => ({ ...row }))),
          get: (id) => request(() => data.get(id)),
          put(row) {
            data.set(row.key ?? row.id, { ...row });
          },
          delete(id) {
            data.delete(id);
          },
          clear() {
            data.clear();
          },
        };
      };
      queueMicrotask(() => tx.oncomplete?.());
      return tx;
    },
  };
}

/** Store with a recording player and one queued track, no DOM or network. */
function harness(track, { local = null, onedrive = null } = {}) {
  const store = new Store(fakeDb());
  store.player = {
    loaded: [],
    plays: 0,
    position: 0,
    setGain() {},
    async load(file) {
      this.loaded.push(file);
    },
    async play() {
      this.plays += 1;
    },
    pause() {},
    seek() {},
    loadUrl() {},
    async playNow() {},
  };
  store.prefetcher = null;
  store.playlog = { record() {} };
  if (local) {
    store.reference = store.local = store.sources.local = local;
  }
  if (onedrive) {
    store.onedrive = store.sources.onedrive = onedrive;
  }
  store.queue = createQueue([track]);
  return store;
}

const TRACK = { id: 'fsa:a.wav', path: 'a.wav', title: 'a', source: 'fsa' };

test('a local permission failure recovers once and retries playback', async () => {
  let reads = 0;
  let permissions = 0;
  const local = {
    kind: 'files',
    permission: () => 'granted',
    async getFile() {
      reads += 1;
      if (reads === 1) throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
      return new Blob(['x']);
    },
    async ensurePermission() {
      permissions += 1;
      return true;
    },
  };
  const store = harness(TRACK, { local });

  assert.equal(await store._loadTrack(TRACK), true);
  assert.equal(reads, 2);
  assert.equal(permissions, 1);
  assert.equal(store.player.plays, 1);
  assert.equal(store.state.permissionIssue, null);
});

test('a denied local retry surfaces the permission issue', async () => {
  let reads = 0;
  let permissions = 0;
  const local = {
    kind: 'files',
    permission: () => 'denied',
    async getFile() {
      reads += 1;
      throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    },
    async ensurePermission() {
      permissions += 1;
      return false;
    },
  };
  const store = harness(TRACK, { local });

  assert.equal(await store._loadTrack(TRACK), false);
  assert.equal(reads, 1);
  assert.equal(permissions, 1);
  assert.equal(store.player.plays, 0);
  assert.deepEqual(store.state.permissionIssue, { kind: 'local', reason: 'permission' });
});

test('a missing file is not treated as a permission failure', async () => {
  let permissions = 0;
  const local = {
    kind: 'files',
    permission: () => 'granted',
    async getFile() {
      throw Object.assign(new Error('gone'), { name: 'NotFoundError' });
    },
    async ensurePermission() {
      permissions += 1;
      return true;
    },
  };
  const store = harness(TRACK, { local });

  assert.equal(await store._loadTrack(TRACK), false);
  assert.equal(permissions, 0);
  assert.equal(store.state.permissionIssue, null);
});

test('a OneDrive 401 forces a token refresh, then retries once', async () => {
  let opens = 0;
  const calls = [];
  const onedrive = {
    kind: 'onedrive',
    name: 'OneDrive',
    permission: () => 'granted',
    async open() {
      opens += 1;
      if (opens === 1) throw Object.assign(new Error('HTTP 401'), { status: 401 });
      return { file: new Blob(['x']) };
    },
    async ensurePermission(options) {
      calls.push(options);
      return true;
    },
  };
  const track = { id: 'onedrive:one.mp3', path: 'one.mp3', title: 'one', source: 'onedrive' };
  const store = harness(track, { onedrive });

  assert.equal(await store._loadTrack(track), true);
  assert.deepEqual(calls, [{ force: true }]);
  assert.equal(opens, 2);
  assert.equal(store.player.plays, 1);
  assert.equal(store.state.permissionIssue, null);
});
