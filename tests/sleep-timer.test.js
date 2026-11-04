import test from 'node:test';
import assert from 'node:assert/strict';

import { SLEEP_MODES, sleepMinutes, createSleepTimer } from '../src/core/sleepTimer.js';

function harness({ now = 0 } = {}) {
  let time = now;
  let nextHandle = 0;
  const timers = new Map();
  const cleared = [];
  const events = [];

  const timer = createSleepTimer({
    now: () => time,
    setInterval: (fn, ms) => {
      nextHandle += 1;
      timers.set(nextHandle, { fn, ms });
      return nextHandle;
    },
    clearInterval: (handle) => {
      cleared.push(handle);
      timers.delete(handle);
    },
    intervalMs: 1000,
    fadeMs: 5000,
    onTick: (state) => events.push({ type: 'tick', state }),
    onFade: (factor) => events.push({ type: 'fade', factor }),
    onStop: () => events.push({ type: 'stop' }),
  });

  return {
    timer,
    timers,
    cleared,
    events,
    advance(ms) {
      time += ms;
    },
    fire() {
      for (const entry of [...timers.values()]) entry.fn();
    },
    stops: () => events.filter((event) => event.type === 'stop').length,
    fades: () => events.filter((event) => event.type === 'fade'),
    ticks: () => events.filter((event) => event.type === 'tick'),
  };
}

test('SLEEP_MODES lists six modes and sleepMinutes maps only minute modes', () => {
  assert.deepEqual(SLEEP_MODES, ['off', '15', '30', '45', '60', 'end']);
  assert.equal(sleepMinutes('15'), 15);
  assert.equal(sleepMinutes('30'), 30);
  assert.equal(sleepMinutes('45'), 45);
  assert.equal(sleepMinutes('60'), 60);
  assert.equal(sleepMinutes('off'), null);
  assert.equal(sleepMinutes('end'), null);
  assert.equal(sleepMinutes('99'), null);
  assert.equal(sleepMinutes(undefined), null);
});

test('minute modes compute endsAt from the injected clock and tick immediately', () => {
  for (const [mode, minutes] of [
    ['15', 15],
    ['30', 30],
    ['45', 45],
    ['60', 60],
  ]) {
    const { timer, ticks, timers } = harness({ now: 1000 });
    timer.set(mode);
    const state = timer.state();
    assert.equal(state.mode, mode);
    assert.equal(state.endsAt, 1000 + minutes * 60000);
    assert.equal(state.remaining, minutes * 60000);
    assert.equal(state.fading, false);
    assert.equal(timers.size, 1, 'one interval per set');
    assert.equal(ticks().length, 1, 'onTick fires on set');
  }
});

test('an invalid mode falls back to off', () => {
  const { timer, timers, ticks } = harness();
  timer.set('99');
  assert.deepEqual(timer.state(), { mode: 'off', endsAt: null, remaining: null, fading: false });
  assert.equal(timers.size, 0);
  assert.equal(ticks().length, 0);
});

test('fade starts at 1, reads 0.5 at half the fade window and stops once', () => {
  const { timer, advance, fire, fades, stops } = harness();
  timer.set('15');
  advance(900000 - 5000);
  fire();
  assert.deepEqual(fades().map((event) => event.factor), [1]);
  assert.equal(timer.state().fading, true);

  advance(2500);
  fire();
  assert.deepEqual(fades().map((event) => event.factor), [1, 0.5]);

  advance(2500);
  fire();
  assert.equal(stops(), 1);
  assert.equal(timer.state().mode, 'off');
  assert.equal(timer.state().endsAt, null);
  assert.equal(timer.state().fading, false);
  assert.equal(fades().length, 2, 'no fade event at zero remaining');
});

test('ticks after the timer finished do not stop again', () => {
  const { timer, advance, fire, cleared, stops } = harness();
  timer.set('15');
  advance(900000);
  fire();
  assert.equal(stops(), 1);
  assert.deepEqual(cleared, [1]);
  advance(1000);
  fire();
  fire();
  assert.equal(stops(), 1);
  assert.deepEqual(cleared, [1]);
});

test("set('end') schedules no interval and fireEnd stops exactly once", () => {
  const { timer, timers, ticks, stops } = harness();
  timer.set('end');
  assert.deepEqual(timer.state(), { mode: 'end', endsAt: null, remaining: null, fading: false });
  assert.equal(timers.size, 0);
  assert.equal(ticks().length, 1);

  timer.fireEnd();
  assert.equal(stops(), 1);
  assert.equal(timer.state().mode, 'off');
  timer.fireEnd();
  assert.equal(stops(), 1, 'a second fireEnd is inert');
});

test('fireEnd is a no-op for minute and off modes', () => {
  const { timer, stops } = harness();
  timer.set('30');
  timer.fireEnd();
  assert.equal(stops(), 0);
  assert.equal(timer.state().mode, '30');
  timer.set('off');
  timer.fireEnd();
  assert.equal(stops(), 0);
});

test('cancel clears the interval without calling onStop', () => {
  const { timer, cleared, stops, timers } = harness();
  timer.set('45');
  assert.equal(timers.size, 1);
  timer.cancel();
  assert.deepEqual(cleared, [1]);
  assert.equal(stops(), 0);
  assert.deepEqual(timer.state(), { mode: 'off', endsAt: null, remaining: null, fading: false });
});

test('state() has a stable shape for off and end', () => {
  const { timer } = harness();
  assert.deepEqual(timer.state(), { mode: 'off', endsAt: null, remaining: null, fading: false });
  timer.set('end');
  const state = timer.state();
  assert.deepEqual(Object.keys(state), ['mode', 'endsAt', 'remaining', 'fading']);
  assert.equal(state.remaining, null);
});

test('destroy clears the interval and makes every later action inert', () => {
  const { timer, timers, cleared, advance, stops, events } = harness();
  timer.set('15');
  const stale = [...timers.values()][0].fn;
  timer.destroy();
  assert.deepEqual(cleared, [1]);
  advance(900000);
  stale();
  timer.set('30');
  timer.fireEnd();
  timer.cancel();
  assert.equal(stops(), 0);
  assert.equal(timers.size, 0);
  assert.equal(events.filter((event) => event.type === 'fade').length, 0);
});
