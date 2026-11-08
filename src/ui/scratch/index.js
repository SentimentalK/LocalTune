/**
 * Scratch audio facade.
 *
 * A backward grab plays the song itself in reverse, using a lazily decoded
 * window (E). The window is decoded from a byte range, so it works for any
 * track length; when the decoded material runs out — or when the source cannot
 * be ranged/decoded — the gesture falls back to rewinding the <audio> element
 * in short bites (D). The reversed buffer never loops.
 *
 * Nothing is created at module load or while idle: the context, the decoded
 * window and the stutter timer exist only while the hand is down.
 */

import { createDecodeWindow } from './decode-window.js';
import { createSeekStutter } from './seek-stutter.js';

const SPEED_REF = 0.4; // deg/ms that counts as a full-speed scratch

const clamp01 = (value) => Math.min(Math.max(Number(value) || 0, 0), 1);

/**
 * @param {{
 *   getContext?: () => AudioContext | null,
 *   createByteSource?: (info: { audio: HTMLAudioElement, track: object | null }) => object | null,
 * }} options
 */
export function createScratchAudio({ getContext, createByteSource = null } = {}) {
  let owned = null; // context created here when the player has none
  let ctx = null; // context the current gesture runs in

  const stutter = createSeekStutter();
  const windowPlayer = createDecodeWindow();

  let active = false;
  let speed = 0;
  let rawSpeed = 0;
  let generation = 0;
  let gestureId = 0;
  let gestureCenter = 0;
  let byteSource = null;
  let currentAudio = null;
  let currentTrack = null;
  let currentTrackId = null;

  function context() {
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
  }

  /** Called from pointerdown: create (or reuse) the context in the gesture. */
  function press() {
    gestureId += 1;
    ctx = context();
    if (!ctx) return;
    try {
      void ctx.resume?.().catch?.(() => {});
    } catch {
      // A context that refuses to resume simply stays silent.
    }
  }

  function begin(audio, trackId, track) {
    currentAudio = audio ?? currentAudio;
    currentTrack = track ?? null;
    currentTrackId = trackId ?? null;
    if (!active) {
      active = true;
      generation += 1;
      gestureCenter = Math.max(Number(currentAudio?.currentTime) || 0, 0);
      byteSource = createByteSource
        ? createByteSource({ audio: currentAudio, track: currentTrack }) ?? null
        : null;
    }
  }

  /** The decoded window ran out: continue with D from the window's end. */
  function handleExhausted(gen, detail) {
    if (gen !== generation || !active) return;
    if (currentAudio) {
      currentAudio.muted = false;
      try {
        if (Number.isFinite(detail?.position)) {
          currentAudio.currentTime = Math.max(detail.position, 0);
        }
      } catch {
        // a not-yet-seekable element keeps its position
      }
    }
    stutter.start(currentAudio, rawSpeed);
  }

  function playReversed(gen) {
    const started = windowPlayer.play({
      ctx,
      destination: ctx.destination,
      audio: currentAudio,
      speed,
      trackId: currentTrackId,
      gestureId,
      onEnded: (detail) => handleExhausted(gen, detail),
    });
    if (!started) {
      // Keep the element (and the D bridge) audible rather than going silent.
      if (currentAudio) currentAudio.muted = false;
      stutter.start(currentAudio, rawSpeed);
      return false;
    }
    stutter.stop();
    if (currentAudio) {
      currentAudio.muted = true;
      if (!currentAudio.paused) {
        try {
          currentAudio.pause();
        } catch {
          // already silent
        }
      }
    }
    return true;
  }

  function waitForDecode(gen) {
    const ticket = windowPlayer.ensure({
      audio: currentAudio,
      trackId: currentTrackId,
      ctx,
      duration:
        Number(currentAudio?.duration) || Number(currentTrack?.duration) || 0,
      center: gestureCenter,
      byteSource,
      gestureId,
    });
    if (ticket.status === 'ready') {
      playReversed(gen);
      return;
    }
    // Keep the stutter running while the first window is decoded: the first
    // grab must never be silent just because decoding takes a beat.
    if (currentAudio) currentAudio.muted = false;
    stutter.start(currentAudio, rawSpeed);
    ticket.promise?.then((result) => {
      if (result?.ok && gen === generation && active) playReversed(gen);
    });
  }

  /**
   * Backward scrub at `rawSpeed` (deg/ms). `audio`/`track`/`trackId` describe
   * the live element and queue row.
   */
  function friction(rawSpeedValue, { audio, trackId, track } = {}) {
    begin(audio, trackId, track);
    if (!currentAudio) return;
    ctx = context() ?? ctx;
    if (!ctx) return;
    rawSpeed = Number(rawSpeedValue) || 0;
    speed = clamp01(rawSpeed / SPEED_REF);
    const gen = generation;

    if (windowPlayer.hasWindow(currentTrackId, currentAudio.currentTime)) {
      playReversed(gen);
    } else {
      waitForDecode(gen);
    }
  }

  /**
   * Stop every voice. The decoded window stays cached so a back-and-forth grab
   * can re-cut into the same fragment instead of re-fetching.
   */
  function silence() {
    generation += 1;
    active = false;
    stutter.stop();
    windowPlayer.stop();
  }

  /** Gesture end: drop the decoded window and its buffers. */
  function release() {
    windowPlayer.release();
    byteSource = null;
  }

  /** A queue track change drops the cached reversed window. */
  function trackChanged(trackId) {
    const id = trackId ?? null;
    if (id === currentTrackId) return;
    currentTrackId = id;
    if (active) {
      generation += 1;
      active = false;
      stutter.stop();
    }
    windowPlayer.release();
    currentTrack = null;
    byteSource = null;
  }

  function state() {
    const decode = windowPlayer.state();
    const stuttering = active && stutter.isActive();
    return {
      engine: !active ? null : decode.sourceActive ? 'e' : stuttering ? 'd' : null,
      decode,
    };
  }

  return {
    press,
    friction,
    silence,
    release,
    state,
    trackChanged,
    isReversing: () => active,
  };
}
