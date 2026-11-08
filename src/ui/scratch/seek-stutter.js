/**
 * Scheme D — seek stutter.
 *
 * The <audio> element keeps decoding and playing the real song. On a backward
 * grab every tick rewinds `currentTime` by 120–180 ms and calls `play()` again,
 * which makes the decoder re-emit a short slice: a tape-rewind / chirp grain
 * instead of silence. A faster hand tightens both the interval (140→100 ms)
 * and the step (120→180 ms), so the grain follows the scratch speed.
 *
 * One setTimeout runs while the hand is down; nothing exists while idle.
 * `stop()` is idempotent so every exit path can call it.
 */

const STEP_MIN_SECONDS = 0.12;
const STEP_MAX_SECONDS = 0.18;
const INTERVAL_MAX_MS = 140;
const INTERVAL_MIN_MS = 100;
const SPEED_REF = 0.4; // deg/ms that counts as a full-speed scratch

const clamp01 = (value) => Math.min(Math.max(Number(value) || 0, 0), 1);

export function createSeekStutter() {
  let audio = null;
  let timer = 0;
  let active = false;
  let speed = 0;

  const stepFor = (value) => STEP_MIN_SECONDS + (STEP_MAX_SECONDS - STEP_MIN_SECONDS) * value;
  const intervalFor = (value) =>
    Math.round(INTERVAL_MAX_MS - (INTERVAL_MAX_MS - INTERVAL_MIN_MS) * value);

  function ensurePlay() {
    if (!audio) return;
    try {
      const pending = audio.play();
      if (pending?.catch) pending.catch(() => {});
    } catch {
      // an element that refuses to play stays silent
    }
  }

  function tick() {
    timer = 0;
    if (!active || !audio) return;
    ensurePlay();
    try {
      audio.currentTime = Math.max(0, (Number(audio.currentTime) || 0) - stepFor(speed));
    } catch {
      // an element that refuses the seek keeps its position
    }
    timer = setTimeout(tick, intervalFor(speed));
  }

  /** Begin (or re-target) the stutter. Safe to call on every pointermove. */
  function start(nextAudio, rawSpeed) {
    if (nextAudio && nextAudio !== audio) audio = nextAudio;
    active = true;
    speed = clamp01(rawSpeed / SPEED_REF);
    if (audio) {
      audio.muted = false;
      audio.preservesPitch = false;
      audio.webkitPreservesPitch = false;
    }
    if (!timer) timer = setTimeout(tick, 0);
  }

  function stop() {
    active = false;
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
  }

  function isActive() {
    return active;
  }

  return { start, stop, isActive };
}
