/**
 * Back-scratch sound. An <audio> element cannot reverse, so the real audio is
 * muted while the hand turns the record backwards and this module voices the
 * friction instead: a looping white-noise bed through a band-pass that opens
 * with the angular speed, plus a short low thump on the same rhythm.
 *
 * Nothing is created at module load or while idle: the AudioContext comes from
 * the player's graph when it exists, is created on the first press otherwise,
 * and every node is stopped and disconnected 70ms after the hand lets go. No
 * requestAnimationFrame: the thump uses one short timer while audible only.
 */

const NOISE_SECONDS = 1;
const FADE_MS = 30;
const TEARDOWN_MS = 70;
const SPEED_REF = 0.4; // deg/ms that counts as a full-speed scratch
const THUMP_MAX_MS = 120;
const THUMP_MIN_MS = 80;

const clamp01 = (value) => Math.min(Math.max(Number(value) || 0, 0), 1);

/**
 * @param {{ getContext?: () => AudioContext | null }} options
 * @returns {{
 *   press: () => void,
 *   friction: (speed: number) => void,
 *   silence: () => void,
 *   stop: () => void,
 *   state: () => { ctxState: string | null, nodeCount: number, audible: boolean, gain: number, lastGain: number, speed: number },
 * }}
 */
export function createScratchAudio({ getContext } = {}) {
  let owned = null; // context created here when the player has none
  let ctx = null; // context the current voice belongs to
  let noiseBuffer = null;
  let voice = null; // { noise, band, gain }
  let thump = null; // { osc, env }
  let thumpTimer = 0;
  let teardownTimer = 0;
  let audible = false;
  let speed = 0;
  let lastGain = 0;

  const context = () => {
    const shared = getContext?.() ?? null;
    if (shared) return shared;
    if (owned) return owned;
    const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext ?? null;
    if (!Ctor) return null;
    try {
      owned = new Ctor();
    } catch {
      owned = null;
    }
    return owned;
  };

  /** Called from pointerdown: create (or reuse) the context in the gesture. */
  function press() {
    const next = context();
    if (!next) return;
    ctx = next;
    try {
      const resumed = ctx.resume?.();
      if (resumed?.catch) resumed.catch(() => {});
    } catch {
      // A context that refuses to resume simply stays silent.
    }
  }

  function makeNoise() {
    if (!ctx) return null;
    if (noiseBuffer && noiseBuffer.sampleRate === ctx.sampleRate) return noiseBuffer;
    const frames = Math.floor(ctx.sampleRate * NOISE_SECONDS);
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < frames; index += 1) data[index] = Math.random() * 2 - 1;
    noiseBuffer = buffer;
    return buffer;
  }

  function build() {
    if (!ctx) return false;
    if (voice) return true;
    const noise = ctx.createBufferSource();
    noise.buffer = makeNoise();
    noise.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 1.1;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    noise.connect(band);
    band.connect(gain);
    gain.connect(ctx.destination);
    noise.start();
    voice = { noise, band, gain };
    return true;
  }

  function stopThump() {
    if (thumpTimer) {
      clearTimeout(thumpTimer);
      thumpTimer = 0;
    }
    if (!thump) return;
    const node = thump;
    thump = null;
    try {
      node.osc.stop();
    } catch {
      // already stopped
    }
    try {
      node.osc.disconnect();
      node.env.disconnect();
    } catch {
      // already disconnected
    }
  }

  function scheduleThump() {
    if (thumpTimer) return;
    const tick = () => {
      thumpTimer = 0;
      if (!audible || !ctx) return;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 60 + 30 * speed;
      env.gain.setValueAtTime(0.0001, now);
      env.gain.exponentialRampToValueAtTime(0.12 + 0.28 * speed, now + 0.008);
      env.gain.exponentialRampToValueAtTime(0.0001, now + 0.07);
      osc.connect(env);
      env.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.09);
      const node = { osc, env };
      thump = node;
      osc.onended = () => {
        try {
          osc.disconnect();
          env.disconnect();
        } catch {
          // already disconnected
        }
        if (thump === node) thump = null;
      };
      thumpTimer = setTimeout(tick, THUMP_MAX_MS - (THUMP_MAX_MS - THUMP_MIN_MS) * speed);
    };
    thumpTimer = setTimeout(tick, 0);
  }

  /** Backward scrub at `rawSpeed` (deg/ms): open the bed and start thumping. */
  function friction(rawSpeed) {
    const next = context();
    if (!next) return;
    if (ctx && next !== ctx && voice) {
      // The player's graph appeared (or changed) between gestures.
      teardown();
    }
    ctx = next;
    if (!build()) return;
    if (teardownTimer) {
      clearTimeout(teardownTimer);
      teardownTimer = 0;
    }
    audible = true;
    speed = clamp01(rawSpeed / SPEED_REF);
    const now = ctx.currentTime;
    const band = 800 + 1400 * speed;
    const level = 0.05 + 0.2 * speed;
    lastGain = level;
    voice.band.frequency.setTargetAtTime(band, now, 0.02);
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setTargetAtTime(level, now, 0.015);
    scheduleThump();
  }

  function teardown() {
    teardownTimer = 0;
    if (!voice || audible) return;
    const { noise, band, gain } = voice;
    voice = null;
    try {
      noise.stop();
    } catch {
      // already stopped
    }
    for (const node of [noise, band, gain]) {
      try {
        node.disconnect();
      } catch {
        // already disconnected
      }
    }
  }

  /** Fade 30ms and tear the nodes down. Safe to call repeatedly. */
  function silence() {
    if (!voice) return;
    audible = false;
    stopThump();
    const now = ctx ? ctx.currentTime : 0;
    try {
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
      voice.gain.gain.linearRampToValueAtTime(0, now + FADE_MS / 1000);
    } catch {
      // a node that refuses the write is already silent
    }
    clearTimeout(teardownTimer);
    teardownTimer = setTimeout(teardown, TEARDOWN_MS);
  }

  function state() {
    return {
      ctxState: ctx?.state ?? null,
      nodeCount: voice ? 3 + (thump ? 2 : 0) : 0,
      audible,
      gain: voice ? Number(voice.gain.gain.value.toFixed(3)) : 0,
      lastGain: Number(lastGain.toFixed(3)),
      speed: Number(speed.toFixed(3)),
    };
  }

  return { press, friction, silence, stop: silence, state };
}
