import assert from 'node:assert/strict';
import test from 'node:test';

import { createSeekStutter } from '../src/ui/scratch/seek-stutter.js';

function fakeAudio(currentTime = 10) {
  return {
    currentTime,
    paused: true,
    muted: true,
    playbackRate: 1,
    preservesPitch: true,
    plays: 0,
    play() {
      this.plays += 1;
      this.paused = false;
      return Promise.resolve();
    },
  };
}

test('D rewinds 120–180 ms every 100–140 ms and unmutes/plays', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const audio = fakeAudio(10);
  const stutter = createSeekStutter();

  // Slow hand: 140 ms interval, 120 ms step.
  stutter.start(audio, 0);
  t.mock.timers.tick(0);
  assert.equal(audio.muted, false);
  assert.equal(audio.paused, false);
  assert.equal(Number(audio.currentTime.toFixed(3)), 9.88);
  assert.equal(stutter.isActive(), true);

  t.mock.timers.tick(140);
  assert.equal(Number(audio.currentTime.toFixed(3)), 9.76);

  // Fast hand: 180 ms step on the next tick (the pending timer keeps its old
  // 140 ms delay until it fires, then the shorter interval takes over).
  stutter.start(audio, 0.4);
  t.mock.timers.tick(140);
  assert.equal(Number(audio.currentTime.toFixed(3)), 9.58);

  stutter.stop();
  assert.equal(stutter.isActive(), false);
  t.mock.timers.tick(1000);
  assert.equal(Number(audio.currentTime.toFixed(3)), 9.58);
});

test('D never goes below zero', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const audio = fakeAudio(0.05);
  const stutter = createSeekStutter();
  stutter.start(audio, 0.4);
  t.mock.timers.tick(0);
  assert.equal(audio.currentTime, 0);
  stutter.stop();
});
