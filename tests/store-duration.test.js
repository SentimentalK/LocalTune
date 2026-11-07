import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Store, probeBlobDuration } from '../src/core/store.js';
import { AudioPlayer } from '../src/core/player.js';
import { createQueue } from '../src/core/queue.js';

/** In-memory IndexedDB double: one Map per store, microtask completion. */
function fakeDb() {
  const stores = new Map();
  const ops = { tracks: { put: 0 } };
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
    stores,
    ops,
    dataFor,
    transaction(name) {
      const names = Array.isArray(name) ? name : [name];
      const tx = { error: null };
      tx.objectStore = (storeName) => {
        const key = storeName ?? names[0];
        const data = dataFor(key);
        return {
          getAll() {
            return request(() => [...data.values()].map((row) => ({ ...row })));
          },
          get(id) {
            return request(() => data.get(id));
          },
          put(row) {
            if (ops[key]) ops[key].put += 1;
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

function trackWithDuration(duration) {
  return {
    id: 'onedrive:a.mp3',
    path: 'a.mp3',
    title: 'a',
    source: 'onedrive',
    duration,
  };
}

function storeWithTrack(duration) {
  const db = fakeDb();
  const store = new Store(db);
  const track = trackWithDuration(duration);
  store.queue = createQueue([track]);
  store._state.tracks = [track];
  store._state.current = { ...store._state.current, track };
  return { db, store, track };
}

test('_adoptTrackDuration fills an unknown duration in state, queue and db', async () => {
  const { db, store } = storeWithTrack(0);

  store._adoptTrackDuration(231.2);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(store.state.tracks[0].duration, 231.2);
  assert.equal(store.state.queue.tracks[0].duration, 231.2);
  assert.equal(db.dataFor('tracks').get('onedrive:a.mp3').duration, 231.2);
});

test('_adoptTrackDuration ignores a sub-second difference and rewrites a larger one', async () => {
  const { db, store } = storeWithTrack(100);

  store._adoptTrackDuration(100.5);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(store.state.tracks[0].duration, 100);
  assert.equal(db.ops.tracks.put, 0);

  store._adoptTrackDuration(300);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(store.state.tracks[0].duration, 300);
});

function fakeAudio() {
  const listeners = new Map();
  return {
    src: '',
    preload: '',
    currentTime: 0,
    duration: 0,
    paused: true,
    ended: false,
    error: null,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const handlers = listeners.get(type) ?? [];
      const index = handlers.indexOf(handler);
      if (index >= 0) handlers.splice(index, 1);
    },
    emit(type, event = {}) {
      for (const handler of [...(listeners.get(type) ?? [])]) handler(event);
    },
    play() {
      return Promise.resolve();
    },
    pause() {},
    load() {},
    removeAttribute() {
      this.src = '';
    },
  };
}

test('the player re-emits loadedmetadata and durationchange as durationchange', () => {
  const audio = fakeAudio();
  const player = new AudioPlayer(audio);
  const seen = [];
  player.addEventListener('durationchange', (event) => seen.push(event.detail.duration));

  audio.duration = 12.5;
  audio.emit('loadedmetadata');
  audio.emit('durationchange');

  assert.deepEqual(seen, [12.5, 12.5]);
});

/** Install a global Audio double; returns the created instances and a restore. */
function installFakeAudio() {
  const instances = [];
  class FakeAudio {
    constructor() {
      this.duration = 0;
      this.preload = '';
      this.src = '';
      this.listeners = new Map();
      this.removedAttributes = [];
      this.loadCalls = 0;
      instances.push(this);
    }
    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(handler);
    }
    removeEventListener(type, handler) {
      const handlers = this.listeners.get(type) ?? [];
      const index = handlers.indexOf(handler);
      if (index >= 0) handlers.splice(index, 1);
    }
    emit(type) {
      for (const handler of [...(this.listeners.get(type) ?? [])]) handler();
    }
    removeAttribute(name) {
      this.removedAttributes.push(name);
      this.src = '';
    }
    load() {
      this.loadCalls += 1;
    }
    get listenerCount() {
      let total = 0;
      for (const handlers of this.listeners.values()) total += handlers.length;
      return total;
    }
  }
  const before = {
    Audio: globalThis.Audio,
    create: URL.createObjectURL,
    revoke: URL.revokeObjectURL,
  };
  const revoked = [];
  globalThis.Audio = FakeAudio;
  URL.createObjectURL = () => 'blob:fake';
  URL.revokeObjectURL = (url) => revoked.push(url);
  return {
    instances,
    revoked,
    restore() {
      globalThis.Audio = before.Audio;
      URL.createObjectURL = before.create;
      URL.revokeObjectURL = before.revoke;
    },
  };
}

test('probeBlobDuration reads the element duration and revokes its URL', async () => {
  const fake = installFakeAudio();
  try {
    const probe = probeBlobDuration(new Blob([new Uint8Array(4)]));
    const audio = fake.instances.at(-1);
    audio.duration = 12.5;
    audio.emit('loadedmetadata');

    assert.equal(await probe, 12.5);
    assert.deepEqual(fake.revoked, ['blob:fake']);
    assert.deepEqual(audio.removedAttributes, ['src']);
    assert.equal(audio.listenerCount, 0);
  } finally {
    fake.restore();
  }
});

test('probeBlobDuration gives up at the timeout and cleans up', async () => {
  const fake = installFakeAudio();
  try {
    const probe = probeBlobDuration(new Blob([new Uint8Array(4)]), { timeout: 10 });
    const audio = fake.instances.at(-1);

    assert.equal(await probe, 0);
    assert.deepEqual(fake.revoked, ['blob:fake']);
    assert.deepEqual(audio.removedAttributes, ['src']);
    assert.equal(audio.loadCalls, 1);
    assert.equal(audio.listenerCount, 0);
  } finally {
    fake.restore();
  }
});
