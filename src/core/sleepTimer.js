/**
 * Sleep timer state machine. The clock and the interval functions are
 * injected so tests drive the whole lifecycle without real time.
 */

export const SLEEP_MODES = ['off', '15', '30', '45', '60', 'end'];

const MINUTES = new Map([
  ['15', 15],
  ['30', 30],
  ['45', 45],
  ['60', 60],
]);

/**
 * Minutes for a minute mode; null for `off`, `end` and anything unknown.
 * @param {unknown} mode
 * @returns {number|null}
 */
export function sleepMinutes(mode) {
  return MINUTES.get(mode) ?? null;
}

/**
 * @param {{
 *   now?: () => number,
 *   setInterval?: (fn: () => void, ms: number) => unknown,
 *   clearInterval?: (handle: unknown) => void,
 *   intervalMs?: number,
 *   fadeMs?: number,
 *   onTick?: (state: object) => void,
 *   onFade?: (factor: number) => void,
 *   onStop?: () => void
 * }} [options]
 */
export function createSleepTimer({
  now = Date.now,
  setInterval: startTimer = setInterval,
  clearInterval: stopTimer = clearInterval,
  intervalMs = 1000,
  fadeMs = 5000,
  onTick = () => {},
  onFade = () => {},
  onStop = () => {},
} = {}) {
  let mode = 'off';
  let endsAt = null;
  let fading = false;
  let handle = null;
  let destroyed = false;

  const state = () => ({
    mode,
    endsAt,
    remaining: endsAt === null ? null : Math.max(0, endsAt - now()),
    fading,
  });

  function clearHandle() {
    if (handle !== null) {
      stopTimer(handle);
      handle = null;
    }
  }

  function reset() {
    mode = 'off';
    endsAt = null;
    fading = false;
  }

  function tick() {
    if (destroyed || endsAt === null) return;
    const remaining = Math.max(0, endsAt - now());
    if (remaining > 0 && remaining <= fadeMs) {
      fading = true;
      onFade(remaining / fadeMs);
    }
    onTick(state());
    if (remaining === 0) {
      clearHandle();
      reset();
      onStop();
    }
  }

  function set(next) {
    if (destroyed) return;
    const value = SLEEP_MODES.includes(next) ? next : 'off';
    clearHandle();
    reset();
    if (value === 'off') return;

    const minutes = sleepMinutes(value);
    mode = value;
    if (minutes !== null) {
      endsAt = now() + minutes * 60000;
      handle = startTimer(tick, intervalMs);
    }
    onTick(state());
  }

  function cancel() {
    if (destroyed) return;
    clearHandle();
    reset();
  }

  function fireEnd() {
    if (destroyed || mode !== 'end') return;
    clearHandle();
    reset();
    onStop();
  }

  function destroy() {
    if (destroyed) return;
    clearHandle();
    destroyed = true;
  }

  return { set, cancel, fireEnd, state, destroy };
}
