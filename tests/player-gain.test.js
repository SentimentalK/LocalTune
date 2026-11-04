import test from 'node:test';
import assert from 'node:assert/strict';

import { AudioPlayer } from '../src/core/player.js';

function fakeAudio() {
  const listeners = new Map();
  return {
    src: '',
    preload: '',
    volume: 1,
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

function fakeContext({ state = 'running' } = {}) {
  const calls = { resume: 0, close: 0, source: 0, gain: 0 };
  const nodes = { source: null, gain: null };
  const ctx = {
    state,
    destination: { name: 'destination' },
    resume: async () => {
      calls.resume += 1;
    },
    close: async () => {
      calls.close += 1;
    },
    createMediaElementSource(element) {
      calls.source += 1;
      nodes.source = { element, connect: () => {} };
      return nodes.source;
    },
    createGain() {
      calls.gain += 1;
      nodes.gain = { gain: { value: 1 }, connect: () => {} };
      return nodes.gain;
    },
  };
  return { ctx, calls, nodes };
}

test('enableLeveling builds the graph once and re-resumes on repeat calls', async () => {
  const audio = fakeAudio();
  const { ctx, calls } = fakeContext();
  const player = new AudioPlayer(audio, { createAudioContext: () => ctx });

  assert.equal(await player.enableLeveling(), true);
  assert.equal(player.levelingReady, true);
  assert.equal(calls.resume, 1);
  assert.equal(calls.source, 1);
  assert.equal(calls.gain, 1);

  assert.equal(await player.enableLeveling(), true);
  assert.equal(calls.resume, 2);
  assert.equal(calls.source, 1, 'the source node is created only once');
  assert.equal(calls.gain, 1);
});

test('enableLeveling refuses a suspended context without wiring the graph', async () => {
  const audio = fakeAudio();
  const { ctx, calls } = fakeContext({ state: 'suspended' });
  const player = new AudioPlayer(audio, { createAudioContext: () => ctx });

  assert.equal(await player.enableLeveling(), false);
  assert.equal(player.levelingReady, false);
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

  player.disableLeveling();
  assert.equal(nodes.gain.gain.value, 1);
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

test('destroy closes the audio context', async () => {
  const audio = fakeAudio();
  const { ctx, calls } = fakeContext();
  const player = new AudioPlayer(audio, { createAudioContext: () => ctx });

  await player.enableLeveling();
  assert.equal(calls.close, 0);
  player.destroy();
  assert.equal(calls.close, 1);
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
