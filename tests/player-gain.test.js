import test from 'node:test';
import assert from 'node:assert/strict';

import { AudioPlayer, LEVELING_COMPRESSOR } from '../src/core/player.js';

function fakeAudio() {
  const listeners = new Map();
  return {
    src: '',
    preload: '',
    volume: 1,
    muted: false,
    currentTime: 0,
    duration: 0,
    paused: true,
    ended: false,
    error: null,
    removed: false,
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    remove() {
      this.removed = true;
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const handlers = listeners.get(type) ?? [];
      const index = handlers.indexOf(handler);
      if (index >= 0) handlers.splice(index, 1);
    },
    listenerCount(type) {
      return (listeners.get(type) ?? []).length;
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

/** Each node records its outgoing edges so the wiring can be asserted. */
function wiringNode(name, extra = {}) {
  return {
    name,
    out: [],
    connect(target) {
      this.out = [...this.out, target];
    },
    disconnect() {
      this.out = [];
    },
    ...extra,
  };
}

const targets = (node) => node.out.map((target) => target.name);

function fakeContext({ state = 'running', compressor = true } = {}) {
  const calls = { resume: 0, close: 0, source: 0, gain: 0, compressor: 0 };
  const nodes = { source: null, gain: null, compressor: null };
  const destination = { name: 'destination' };
  const ctx = {
    state,
    destination,
    resume: async () => {
      calls.resume += 1;
    },
    close: async () => {
      calls.close += 1;
    },
    createMediaElementSource(element) {
      calls.source += 1;
      nodes.source = wiringNode('source', { element });
      return nodes.source;
    },
    createGain() {
      calls.gain += 1;
      nodes.gain = wiringNode('gain', { gain: { value: 1 } });
      return nodes.gain;
    },
  };
  if (compressor) {
    ctx.createDynamicsCompressor = () => {
      calls.compressor += 1;
      nodes.compressor = wiringNode('compressor', {
        threshold: { value: 0 },
        knee: { value: 0 },
        ratio: { value: 0 },
        attack: { value: 0 },
        release: { value: 0 },
        Q: { value: 1 },
      });
      return nodes.compressor;
    };
  }
  return { ctx, calls, nodes, destination };
}

test('enableLeveling builds source → gain → compressor → destination', async () => {
  const audio = fakeAudio();
  const { ctx, calls, nodes, destination } = fakeContext();
  const player = new AudioPlayer(audio, { createAudioContext: () => ctx });

  assert.equal(await player.enableLeveling(), true);
  assert.equal(player.levelingReady, true);
  assert.equal(player.levelingMode, 'full');
  assert.equal(calls.resume, 1);
  assert.equal(calls.source, 1);
  assert.equal(calls.gain, 1);
  assert.equal(calls.compressor, 1);

  assert.equal(nodes.source.element, audio);
  assert.deepEqual(targets(nodes.source), ['gain']);
  assert.deepEqual(targets(nodes.gain), ['compressor']);
  assert.equal(nodes.compressor.out.length, 1);
  assert.equal(nodes.compressor.out[0], destination);
  for (const [key, value] of Object.entries(LEVELING_COMPRESSOR)) {
    assert.equal(nodes.compressor[key].value, value, `${key} matches the scan`);
  }

  // A second call only re-resumes; no node is created twice.
  assert.equal(await player.enableLeveling(), true);
  assert.equal(calls.resume, 2);
  assert.equal(calls.source, 1);
  assert.equal(calls.gain, 1);
  assert.equal(calls.compressor, 1);
  assert.equal(player.levelingMode, 'full');
});

test('enableLeveling falls back to gain-only without a compressor node', async () => {
  const audio = fakeAudio();
  const { ctx, calls, nodes } = fakeContext({ compressor: false });
  const player = new AudioPlayer(audio, { createAudioContext: () => ctx });

  assert.equal(await player.enableLeveling(), true);
  assert.equal(player.levelingReady, true);
  assert.equal(player.levelingMode, 'gain-only');
  assert.equal(calls.compressor, 0);
  assert.deepEqual(targets(nodes.gain), ['destination']);
});

test('enableLeveling refuses a suspended context without wiring the graph', async () => {
  const audio = fakeAudio();
  const { ctx, calls } = fakeContext({ state: 'suspended' });
  const player = new AudioPlayer(audio, { createAudioContext: () => ctx });

  assert.equal(await player.enableLeveling(), false);
  assert.equal(player.levelingReady, false);
  assert.equal(player.levelingMode, 'off');
  assert.equal(calls.source, 0, 'an element routed into a suspended context would be silent');
  assert.equal(calls.close, 1);
});

test('setGain applies the factor once the graph exists', async () => {
  const audio = fakeAudio();
  const { ctx, nodes } = fakeContext();
  const player = new AudioPlayer(audio, { createAudioContext: () => ctx });

  player.setGain(-6);
  assert.equal(nodes.gain, null, 'no graph yet, the value is only remembered');
  assert.equal(await player.enableLeveling(), true);
  assert.ok(Math.abs(nodes.gain.gain.value - 0.5011) < 0.001, 'remembered gain is applied');

  player.setGain(3);
  assert.ok(Math.abs(nodes.gain.gain.value - 1.4125) < 0.001);
});

test('disableLeveling bypasses the compressor and enableLeveling restores it', async () => {
  const audio = fakeAudio();
  const { ctx, nodes } = fakeContext();
  const player = new AudioPlayer(audio, { createAudioContext: () => ctx });

  assert.equal(await player.enableLeveling(), true);
  player.setGain(-6);

  player.disableLeveling();
  assert.equal(nodes.gain.gain.value, 1);
  assert.deepEqual(targets(nodes.gain), ['destination'], 'gain now bypasses the compressor');
  assert.equal(player.levelingMode, 'off');
  assert.equal(player.levelingReady, true, 'the context survives a toggle');

  player.setGain(-7.25);
  assert.equal(await player.enableLeveling(), true);
  assert.equal(player.levelingMode, 'full');
  assert.deepEqual(targets(nodes.gain), ['compressor']);
  assert.deepEqual(targets(nodes.compressor), ['destination']);
  assert.ok(Math.abs(nodes.gain.gain.value - 0.434) < 0.001);
});

test('detachGraph closes the context and moves to a fresh element', async () => {
  const audio = fakeAudio();
  const created = [];
  const { ctx, calls } = fakeContext();
  const player = new AudioPlayer(audio, {
    createAudioContext: () => ctx,
    createElement: () => {
      const element = fakeAudio();
      created.push(element);
      return element;
    },
  });

  assert.equal(await player.enableLeveling(), true);
  const changes = [];
  player.addEventListener('elementchange', (event) => changes.push(event.detail.audio));

  assert.equal(await player.detachGraph(), true);
  assert.equal(calls.close, 1);
  assert.equal(player.levelingReady, false);
  assert.equal(player.levelingMode, 'off');
  assert.equal(player.audio, created[0]);
  assert.equal(audio.removed, true, 'the old element is taken out of the document');
  assert.equal(created[0].attributes['aria-hidden'], 'true');
  assert.deepEqual(changes, [created[0]]);

  // The same handler list is live on the new element.
  let updates = 0;
  player.addEventListener('timeupdate', () => {
    updates += 1;
  });
  created[0].emit('timeupdate');
  assert.equal(updates, 1);
});

test('detachGraph refuses to run without a factory or a graph', async () => {
  const audio = fakeAudio();
  const { ctx } = fakeContext();
  const player = new AudioPlayer(audio, { createAudioContext: () => ctx });
  assert.equal(await player.detachGraph(), false, 'no graph yet');

  await player.enableLeveling();
  assert.equal(await player.detachGraph(), false, 'no element factory');
  assert.equal(player.levelingReady, true, 'the graph is untouched when nothing can replace it');
  assert.equal(player.audio, audio);
});

test('destroy closes the audio context', async () => {
  const audio = fakeAudio();
  const { ctx, calls } = fakeContext();
  const player = new AudioPlayer(audio, { createAudioContext: () => ctx });

  await player.enableLeveling();
  assert.equal(calls.close, 0);
  player.destroy();
  assert.equal(calls.close, 1);
  assert.equal(player.levelingReady, false);
});

test('enableLeveling returns false when no context factory can be found', async () => {
  const saved = {
    AudioContext: globalThis.AudioContext,
    webkitAudioContext: globalThis.webkitAudioContext,
  };
  delete globalThis.AudioContext;
  delete globalThis.webkitAudioContext;
  try {
    const player = new AudioPlayer(fakeAudio());
    assert.equal(await player.enableLeveling(), false);
    assert.equal(player.levelingReady, false);
  } finally {
    if (saved.AudioContext !== undefined) globalThis.AudioContext = saved.AudioContext;
    if (saved.webkitAudioContext !== undefined) {
      globalThis.webkitAudioContext = saved.webkitAudioContext;
    }
  }
});

test('canHandOffSynchronously follows whether a source is loaded', () => {
  const audio = fakeAudio();
  const player = new AudioPlayer(audio);
  assert.equal(player.canHandOffSynchronously, false);
  audio.src = 'blob:one';
  assert.equal(player.canHandOffSynchronously, true);
  player.loadUrl('blob:two');
  assert.equal(player.canHandOffSynchronously, true);
});
