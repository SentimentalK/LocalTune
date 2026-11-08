import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DOWNSAMPLE_RATE,
  MAX_WHOLE_SECONDS,
  RANGE_SECONDS,
  createDecodeWindow,
} from '../src/ui/scratch/decode-window.js';

function fakeBuffer(seconds, { channels = 2, sampleRate = 48_000 } = {}) {
  const length = Math.max(Math.round(seconds * sampleRate), 1);
  const data = Array.from({ length: channels }, (_, channel) => {
    const samples = new Float32Array(length);
    for (let index = 0; index < length; index += 1) {
      samples[index] = index + channel / 10;
    }
    return samples;
  });
  return {
    sampleRate,
    length,
    numberOfChannels: channels,
    duration: seconds,
    getChannelData: (channel) => data[channel],
  };
}

function fakeContext(decoded) {
  const nodes = [];
  return {
    currentTime: 0,
    destination: {},
    decoded,
    nodes,
    buffers: [],
    decodeAudioData() {
      return Promise.resolve(decoded);
    },
    createBuffer(channels, frames, sampleRate) {
      const data = Array.from({ length: channels }, () => new Float32Array(frames));
      const buffer = {
        length: frames,
        numberOfChannels: channels,
        sampleRate,
        duration: frames / sampleRate,
        getChannelData: (channel) => data[channel],
      };
      this.buffers.push(buffer);
      return buffer;
    },
    createBufferSource() {
      const node = {
        context: this,
        buffer: null,
        loop: true,
        started: false,
        stopped: false,
        offset: 0,
        playbackRate: {
          value: 1,
          setTargetAtTime(value) {
            this.value = value;
          },
        },
        connect() {},
        disconnect() {},
        start(_when, offset) {
          this.started = true;
          this.offset = offset;
        },
        stop() {
          this.stopped = true;
        },
        onended: null,
      };
      nodes.push(node);
      return node;
    },
    createGain() {
      return {
        gain: {
          value: 1,
          setValueAtTime() {},
          exponentialRampToValueAtTime() {},
          linearRampToValueAtTime() {},
        },
        connect() {},
        disconnect() {},
      };
    },
  };
}

function rangeByteSource(decoded, { size = 1_000_000, audioStart = 10_000 } = {}) {
  return {
    describe: async () => ({ size, audioStart }),
    read: async () => new ArrayBuffer(4096),
  };
}

test('a track over the whole-decode cap is refused without reading bytes', async () => {
  let reads = 0;
  const windowPlayer = createDecodeWindow();
  const audio = { duration: MAX_WHOLE_SECONDS + 30, currentTime: 100, currentSrc: 'blob:x' };
  const ticket = windowPlayer.ensure({
    audio,
    trackId: 'long',
    ctx: {},
    duration: audio.duration,
    center: 100,
    gestureId: 1,
    byteSource: {
      describe: async () => null,
      read: async () => {
        reads += 1;
        return new ArrayBuffer(0);
      },
      readAll: async () => {
        reads += 1;
        return new ArrayBuffer(0);
      },
    },
  });
  assert.equal(ticket.status, 'loading');
  const result = await ticket.promise;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'long');
  assert.equal(reads, 0, 'no byte read is allowed past the duration cap');
  assert.equal(windowPlayer.state().cached, false);
});

test('range decode keeps a 16 s window and reverses the decoded fragment', async () => {
  const decoded = fakeBuffer(20);
  const ctx = fakeContext(decoded);
  const windowPlayer = createDecodeWindow();
  const audio = { duration: 300, currentTime: 60, currentSrc: 'http://x/y.mp3' };
  const ticket = windowPlayer.ensure({
    audio,
    trackId: 'song',
    ctx,
    duration: 300,
    center: 60,
    gestureId: 1,
    byteSource: rangeByteSource(decoded),
  });
  const result = await ticket.promise;
  assert.equal(result.ok, true);

  const state = windowPlayer.state();
  assert.equal(state.cached, true);

  // The reversed fragment starts at the last frame of the decoded copy and
  // drops the 30 ms pre-roll.
  const buffer = ctx.buffers.at(-1);
  const skip = Math.round(0.03 * decoded.sampleRate);
  assert.equal(buffer.length, decoded.length - skip);
  assert.equal(buffer.getChannelData(0)[0], decoded.getChannelData(0).at(-1));
  assert.equal(buffer.getChannelData(0).at(-1), decoded.getChannelData(0)[skip]);
});

test('no-loop source advances its offset and never wraps', async () => {
  const decoded = fakeBuffer(20);
  const ctx = fakeContext(decoded);
  const windowPlayer = createDecodeWindow();
  const audio = { duration: 300, currentTime: 60, currentSrc: 'http://x/y.mp3' };
  const ticket = windowPlayer.ensure({
    audio,
    trackId: 'song',
    ctx,
    duration: 300,
    center: 60,
    gestureId: 7,
    byteSource: rangeByteSource(decoded),
  });
  await ticket.promise;

  assert.equal(
    windowPlayer.play({
      ctx,
      destination: ctx.destination,
      audio,
      speed: 0.2,
      trackId: 'song',
      gestureId: 7,
      onEnded: () => {},
    }),
    true,
  );
  const node = ctx.nodes.at(-1);
  assert.equal(node.loop, false, 'E must not loop the window');
  assert.equal(node.started, true);

  const offsets = [];
  for (let index = 0; index < 20; index += 1) {
    ctx.currentTime += 0.05;
    offsets.push(windowPlayer.state().offset);
  }
  for (let index = 1; index < offsets.length; index += 1) {
    assert.ok(offsets[index] < offsets[index - 1], `offset ${index} must rewind`);
  }

  // Simulate the buffer end: the source is exhausted and a replay is refused.
  node.onended();
  assert.equal(windowPlayer.state().sourceActive, false);
  assert.equal(
    windowPlayer.play({
      ctx,
      destination: ctx.destination,
      audio,
      speed: 0.2,
      trackId: 'song',
      gestureId: 7,
      onEnded: () => {},
    }),
    false,
  );
});

test('whole-track fallback downsamples to mono 22.05 kHz and keeps a 16 s window', async () => {
  const decoded = fakeBuffer(60);
  const ctx = fakeContext(decoded);
  const windowPlayer = createDecodeWindow();
  const audio = { duration: 60, currentTime: 30, currentSrc: 'blob:x' };
  const ticket = windowPlayer.ensure({
    audio,
    trackId: 'whole',
    ctx,
    duration: 60,
    center: 30,
    gestureId: 2,
    byteSource: {
      describe: async () => null,
      read: async () => new ArrayBuffer(4096),
    },
  });
  const result = await ticket.promise;
  assert.equal(result.ok, true);

  const state = windowPlayer.state();
  assert.equal(state.cached, true);
  const buffer = ctx.buffers.at(-1);
  assert.equal(buffer.numberOfChannels, 1);
  assert.equal(buffer.sampleRate, DOWNSAMPLE_RATE);
  assert.equal(buffer.length, Math.round(60 * DOWNSAMPLE_RATE));
});

test('release drops the decoded buffer and its source', async () => {
  const decoded = fakeBuffer(20);
  const ctx = fakeContext(decoded);
  const windowPlayer = createDecodeWindow();
  const audio = { duration: 300, currentTime: 60, currentSrc: 'http://x/y.mp3' };
  const ticket = windowPlayer.ensure({
    audio,
    trackId: 'song',
    ctx,
    duration: 300,
    center: 60,
    gestureId: 3,
    byteSource: rangeByteSource(decoded),
  });
  await ticket.promise;
  assert.equal(windowPlayer.state().cached, true);
  windowPlayer.release();
  const after = windowPlayer.state();
  assert.equal(after.cached, false);
  assert.equal(after.sourceActive, false);
});

test('a fetch/range failure falls back to whole, then to a tagged failure', async () => {
  const windowPlayer = createDecodeWindow();
  const audio = { duration: 30, currentTime: 5, currentSrc: 'https://cross-origin/x.mp3' };
  let ticket = windowPlayer.ensure({
    audio,
    trackId: 'remote',
    ctx: {},
    duration: 30,
    center: 5,
    gestureId: 4,
    byteSource: {
      describe: async () => {
        throw new Error('no-range');
      },
      read: async () => {
        throw new Error('offline');
      },
    },
  });
  const result = await ticket.promise;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'range');
});
