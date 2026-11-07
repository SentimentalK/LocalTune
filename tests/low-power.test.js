import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLowPowerGate,
  LOW_POWER_MIN_ACTIVE_MS,
  LOW_POWER_TASK_MS,
  LOW_POWER_WINDOW_MS,
} from '../src/ui/lowPower.js';

test('two long tasks above the threshold enter low power', () => {
  const gate = createLowPowerGate();
  const now = 1_000;
  assert.equal(gate.verdict(now, false, 0), null);
  assert.equal(gate.noteLongTask(150, now), false);
  assert.equal(gate.verdict(now, false, 0), null);
  assert.equal(gate.noteLongTask(150, now + 10), true);
  assert.equal(gate.verdict(now + 10, false, 0), 'enter');
});

test('a single long task and short tasks do not enter', () => {
  const gate = createLowPowerGate();
  assert.equal(gate.noteLongTask(LOW_POWER_TASK_MS, 500), false);
  assert.equal(gate.noteLongTask(90, 510), false);
  assert.equal(gate.count(600), 0);
  assert.equal(gate.verdict(600, false, 0), null);
});

test('long tasks spread past the window drop the earlier one', () => {
  const gate = createLowPowerGate();
  gate.noteLongTask(150, 1_000);
  const late = 1_000 + LOW_POWER_WINDOW_MS + 1;
  assert.equal(gate.noteLongTask(150, late), false);
  assert.equal(gate.count(late), 0);
  assert.equal(gate.verdict(late, false, 0), null);
});

test('five consecutive frame gaps enter, a normal frame resets the streak', () => {
  const gate = createLowPowerGate();
  let now = 2_000;
  for (let i = 0; i < 4; i += 1) {
    now += 100;
    assert.equal(gate.noteFrameGap(100, now), false);
  }
  assert.equal(gate.noteFrameGap(16, now + 16), false);
  now += 16;
  for (let i = 0; i < 4; i += 1) {
    now += 100;
    assert.equal(gate.noteFrameGap(100, now), false);
  }
  assert.equal(gate.count(now), 0);
  now += 100;
  assert.equal(gate.noteFrameGap(100, now), true);
  assert.equal(gate.verdict(now, false, 0), 'enter');
});

test('an audio stall alone enters', () => {
  const gate = createLowPowerGate();
  assert.equal(gate.noteAudio(3_000), true);
  assert.equal(gate.verdict(3_000, false, 0), 'enter');
});

test('exit needs an empty window and the minimum active stretch', () => {
  const gate = createLowPowerGate();
  const now = 50_000;
  assert.equal(gate.verdict(now, true, now - LOW_POWER_MIN_ACTIVE_MS - 1_000), 'exit');
  assert.equal(gate.verdict(now, true, now - 5_000), null);
  gate.noteAudio(now);
  assert.equal(gate.verdict(now, true, now - LOW_POWER_MIN_ACTIVE_MS - 1_000), null);
});

test('clear wipes triggers and streaks', () => {
  const gate = createLowPowerGate();
  gate.noteLongTask(150, 1_000);
  gate.noteLongTask(150, 1_010);
  for (let i = 0; i < 5; i += 1) gate.noteFrameGap(200, 1_000);
  gate.noteAudio(1_020);
  gate.clear();
  assert.equal(gate.count(1_030), 0);
  assert.equal(gate.verdict(1_030, false, 0), null);
  assert.equal(gate.noteLongTask(150, 1_040), false);
});
