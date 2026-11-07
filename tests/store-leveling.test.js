import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/core/store.js';
import { createQueue } from '../src/core/queue.js';
import { gainFactor } from '../src/core/gain.js';

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

/**
 * An ID3v2.3 tag carrying `REPLAYGAIN_TRACK_GAIN=-7.25 dB` in a TXXX frame,
 * followed by arbitrary audio bytes. Only the head is ever parsed.
 */
function taggedBlob(db = -7.25) {
  const tag = Buffer.from('REPLAYGAIN_TRACK_GAIN', 'utf8');
  const value = Buffer.from(`${db} dB`, 'utf8');
  const payload = Buffer.concat([Buffer.from([3]), tag, Buffer.from([0]), value, Buffer.from([0])]);
  const frame = Buffer.alloc(10 + payload.length);
  frame.write('TXXX', 0, 'latin1');
  frame.writeUInt32BE(payload.length, 4);
  payload.copy(frame, 10);
  const size = frame.length;
  const header = Buffer.from([
    0x49,
    0x44,
    0x33, // "ID3"
    3,
    0,
    0, // v2.3, no flags
    (size >> 21) & 0x7f,
    (size >> 14) & 0x7f,
    (size >> 7) & 0x7f,
    size & 0x7f,
  ]);
  return new Blob([Buffer.concat([header, frame, Buffer.alloc(64)])], { type: 'audio/mpeg' });
}

const silentBlob = () => new Blob([Buffer.alloc(256)], { type: 'audio/mpeg' });

/** Recording player double; every leveling call lands in `record`. */
function fakePlayer({ ready = false, mode = 'off' } = {}) {
  const record = {
    dbs: [],
    gains: [],
    enables: 0,
    disables: 0,
    detaches: 0,
    loads: 0,
    urls: [],
    plays: 0,
  };
  const player = {
    record,
    levelingReady: ready,
    levelingMode: mode,
    position: 0,
    duration: 0,
    setGain(db) {
      // Mirrors AudioPlayer.setGain: the raw dB is remembered, the node value
      // is the clamped factor.
      record.dbs.push(db ?? null);
      record.gains.push(gainFactor(db));
    },
    async enableLeveling() {
      record.enables += 1;
      player.levelingReady = true;
      player.levelingMode = 'full';
      return true;
    },
    disableLeveling() {
      record.disables += 1;
      player.levelingMode = 'off';
    },
    async detachGraph() {
      record.detaches += 1;
      player.levelingReady = false;
      player.levelingMode = 'off';
      return true;
    },
    async load() {
      record.loads += 1;
    },
    loadUrl(url) {
      record.urls.push(url);
    },
    async play() {
      record.plays += 1;
    },
    async playNow() {
      record.plays += 1;
      return undefined;
    },
    pause() {},
    seek() {},
    setVolume() {},
  };
  return player;
}

/** Store with a recording player and one queued track, no DOM or network. */
function harness(track, { local = null, onedrive = null, player = fakePlayer() } = {}) {
  const store = new Store(fakeDb());
  store.player = player;
  store.prefetcher = null;
  store.playlog = { record() {} };
  if (local) {
    store.reference = store.local = store.sources.local = local;
  }
  if (onedrive) {
    store.onedrive = store.sources.onedrive = onedrive;
  }
  store.queue = createQueue([track]);
  store._state.current = { ...store._state.current, track };
  store._state.settings = { ...store._state.settings, leveling: true };
  return store;
}

/** `_loadTrack` fires the gain read without awaiting it. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const LOCAL_TRACK = { id: 'fsa:a.mp3', path: 'a.mp3', title: 'a', source: 'fsa' };
const REMOTE_TRACK = { id: 'onedrive:one.mp3', path: 'one.mp3', title: 'one', source: 'onedrive' };

test('a local track with a ReplayGain tag applies the factor and reaches full', async () => {
  const local = {
    kind: 'files',
    permission: () => 'granted',
    async getFile() {
      return taggedBlob();
    },
  };
  const player = fakePlayer();
  const store = harness(LOCAL_TRACK, { local, player });

  assert.equal(await store._loadTrack(LOCAL_TRACK), true);
  await settle();

  assert.equal(player.record.loads, 1);
  assert.equal(player.record.enables, 1);
  assert.equal(player.record.dbs.at(-1), -7.25);
  assert.equal(player.record.gains.at(-1), gainFactor(-7.25));
  assert.ok(Math.abs(gainFactor(-7.25) - 0.434) < 0.002);
  assert.equal(store.state.levelingMode, 'full');
  assert.equal(store.state.levelingNote, null);
});

test('a local track without tags falls back to unity gain but keeps the chain', async () => {
  const local = {
    kind: 'files',
    permission: () => 'granted',
    async getFile() {
      return silentBlob();
    },
  };
  const player = fakePlayer();
  const store = harness(LOCAL_TRACK, { local, player });

  assert.equal(await store._loadTrack(LOCAL_TRACK), true);
  await settle();

  assert.equal(player.record.dbs.at(-1), null);
  assert.equal(player.record.gains.at(-1), 1);
  assert.equal(store.state.levelingMode, 'full');
});

test('a cached remote track is a Blob, so it gets the full chain', async () => {
  const onedrive = {
    kind: 'onedrive',
    name: 'OneDrive',
    permission: () => 'granted',
    async open() {
      return { file: taggedBlob() };
    },
  };
  const player = fakePlayer();
  const store = harness(REMOTE_TRACK, { onedrive, player });

  assert.equal(await store._loadTrack(REMOTE_TRACK), true);
  await settle();

  assert.equal(player.record.detaches, 0);
  assert.equal(player.record.enables, 1);
  assert.equal(player.record.dbs.at(-1), -7.25);
  assert.equal(player.record.gains.at(-1), gainFactor(-7.25));
  assert.equal(store.state.levelingMode, 'full');
});

test('a streaming remote track bypasses the graph and swaps the element', async () => {
  const onedrive = {
    kind: 'onedrive',
    name: 'OneDrive',
    permission: () => 'granted',
    async open() {
      return { url: 'https://download.test/x', cache: Promise.resolve() };
    },
  };
  const player = fakePlayer({ ready: true, mode: 'full' });
  const store = harness(REMOTE_TRACK, { onedrive, player });

  assert.equal(await store._loadTrack(REMOTE_TRACK), true);
  await settle();

  assert.deepEqual(player.record.urls, ['https://download.test/x']);
  assert.equal(player.record.detaches, 1);
  assert.equal(player.record.enables, 0);
  assert.equal(player.record.dbs.at(-1), null);
  assert.equal(store.state.levelingMode, 'off');
  assert.equal(store.state.levelingNote, 'streaming');
});

test('a streamed track never builds a graph even without an element to swap', async () => {
  const onedrive = {
    kind: 'onedrive',
    name: 'OneDrive',
    permission: () => 'granted',
    async open() {
      return { url: 'https://download.test/y', cache: Promise.resolve() };
    },
  };
  const player = fakePlayer();
  const store = harness(REMOTE_TRACK, { onedrive, player });

  assert.equal(await store._loadTrack(REMOTE_TRACK), true);
  await settle();

  assert.equal(player.record.enables, 0);
  assert.equal(player.record.detaches, 0, 'nothing is wired, so nothing needs swapping');
  assert.equal(store.state.levelingNote, 'streaming');
});

test('with the setting off no graph is built and the mode stays off', async () => {
  const local = {
    kind: 'files',
    permission: () => 'granted',
    async getFile() {
      return taggedBlob();
    },
  };
  const player = fakePlayer();
  const store = harness(LOCAL_TRACK, { local, player });
  store._state.settings = { ...store._state.settings, leveling: false };

  assert.equal(await store._loadTrack(LOCAL_TRACK), true);
  await settle();

  assert.equal(player.record.enables, 0);
  assert.equal(player.record.dbs.at(-1), null);
  assert.equal(store.state.levelingMode, 'off');
  assert.equal(store.state.levelingNote, null);
});

test('the store follows the element announced by elementchange', async () => {
  const savedAudio = globalThis.Audio;
  const elements = [];
  globalThis.Audio = function FakeAudio() {
    const element = {
      src: '',
      preload: '',
      volume: 1,
      muted: false,
      currentTime: 0,
      duration: 0,
      paused: true,
      ended: false,
      error: null,
      attributes: {},
      setAttribute(name, value) {
        this.attributes[name] = value;
      },
      addEventListener() {},
      removeEventListener() {},
      play: async () => {},
      pause() {},
      load() {},
      removeAttribute() {
        this.src = '';
      },
    };
    elements.push(element);
    return element;
  };
  try {
    const store = new Store(fakeDb());
    const next = { ...elements[0], src: 'blob:next' };
    assert.equal(store.audio, elements[0]);
    store.player.dispatchEvent(new CustomEvent('elementchange', { detail: { audio: next } }));
    assert.equal(store.audio, next);
  } finally {
    if (savedAudio === undefined) delete globalThis.Audio;
    else globalThis.Audio = savedAudio;
  }
});
