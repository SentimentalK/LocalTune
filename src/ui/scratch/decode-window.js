/**
 * Scheme E — decode a window of the song and play it backwards.
 *
 * Two decoders, in priority order:
 *
 * 1. Range (`path:"range"`): ask the byte source for ~10 s either side of the
 *    playhead, decode just that MP3/OGG fragment and reverse the result. This
 *    works for any track length and keeps the decoded bytes bounded (20 s).
 *    The first 30 ms are dropped: a range can start mid-frame and decoders may
 *    emit boundary garbage before the first complete frame.
 * 2. Whole track (`path:"whole"`): when the source has no range support, decode
 *    once and immediately downsample to mono 22.05 kHz float32. Duration is
 *    capped at 8 minutes; the retained buffer is capped too. This path is the
 *    memory fallback, not the normal one.
 *
 * A 16 s window (±8 s) is exposed around the gesture's centre. The reversed
 * buffer may contain a little extra margin, but it never loops: when the
 * decoded material runs out the source ends and the caller can fall back to
 * D's stutter. The cache is released when the hand lets go, and on track
 * change; `state()` keeps the last run's sizes for diagnostics.
 *
 * Nothing is fetched, decoded, or allocated at module load or while idle.
 */

export const RANGE_SECONDS = 10;
export const PREROLL_SECONDS = 0.03;
export const MAX_WHOLE_SECONDS = 8 * 60;
export const DOWNSAMPLE_RATE = 22050;
const SPEED_REF = 0.4;
const RATE_MIN = 0.25;
const RATE_MAX = 3;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const clamp01 = (value) => clamp(Number(value) || 0, 0, 1);

/** Reversed copy of a decoded fragment, dropping `skip` frames at the front. */
function reverseFragment(ctx, decoded, skip) {
  const channels = Math.min(decoded.numberOfChannels, 2);
  const frames = Math.max(decoded.length - skip, 0);
  if (!(frames > 0) || !(channels > 0)) return null;
  const buffer = ctx.createBuffer(channels, frames, decoded.sampleRate);
  for (let channel = 0; channel < channels; channel += 1) {
    const from = decoded.getChannelData(channel);
    const to = buffer.getChannelData(channel);
    to.set(from.subarray(skip, skip + frames));
    to.reverse();
  }
  return buffer;
}

/** Mono 22.05 kHz copy of the decoded track, reversed in place. */
function downsampleReversed(ctx, decoded) {
  const frames = Math.max(Math.floor(decoded.duration * DOWNSAMPLE_RATE), 1);
  const buffer = ctx.createBuffer(1, frames, DOWNSAMPLE_RATE);
  const out = buffer.getChannelData(0);
  const sources = [];
  for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
    sources.push(decoded.getChannelData(channel));
  }
  const ratio = decoded.sampleRate / DOWNSAMPLE_RATE;
  const count = sources.length;
  for (let index = 0; index < frames; index += 1) {
    const position = index * ratio;
    const low = Math.floor(position);
    const high = Math.min(low + 1, decoded.length - 1);
    const mix = position - low;
    let sample = 0;
    for (let channel = 0; channel < count; channel += 1) {
      const data = sources[channel];
      const first = data[low] ?? 0;
      const second = data[high] ?? first;
      sample += first + (second - first) * mix;
    }
    out[index] = sample / count;
  }
  out.reverse();
  return buffer;
}

export function createDecodeWindow() {
  let cache = null;
  let pending = null; // { trackId, gestureId, promise }
  let failure = null; // { trackId, gestureId, code }
  let exhausted = null; // { trackId, gestureId }
  let epoch = 0; // bumped by release/track change; stale builds must not cache

  let source = null;
  let cursor = 0; // original-time playhead of the reversed source
  let lastAt = 0;
  let currentRate = 1;

  function advance() {
    if (!source) return;
    const now = source.context.currentTime;
    const delta = Math.max(now - lastAt, 0);
    lastAt = now;
    cursor -= delta * currentRate;
    if (cache) cursor = clamp(cursor, cache.segmentStart, cache.segmentEnd);
  }

  function release() {
    epoch += 1;
    if (source) advance();
    stop();
    cache = null;
    pending = null;
    failure = null;
    exhausted = null;
  }

  function hasWindow(trackId, position) {
    if (!cache || cache.trackId !== trackId) return false;
    const value = Number(position);
    if (!Number.isFinite(value)) return false;
    return value >= cache.segmentStart + 0.1 && value <= cache.segmentEnd - 0.1;
  }

  async function buildRange({ ctx, byteSource, center, total }) {
    if (!byteSource) throw new Error('no-source');
    const info = await byteSource.describe();
    if (!info || !(info.size > 0)) throw new Error('no-source');
    const audioStart = Math.min(Math.max(Number(info.audioStart) || 0, 0), info.size);
    const audioBytes = info.size - audioStart;
    if (!(audioBytes > 1024)) throw new Error('no-audio-bytes');

    const bytesPerSecond = audioBytes / total;
    const startSeconds = clamp(center - RANGE_SECONDS, 0, total);
    const endSeconds = clamp(center + RANGE_SECONDS, 0, total);
    const startByte = clamp(
      Math.floor(audioStart + startSeconds * bytesPerSecond),
      audioStart,
      info.size,
    );
    const endByte = clamp(
      Math.ceil(audioStart + endSeconds * bytesPerSecond),
      startByte + 1,
      info.size,
    );
    const bytes = await byteSource.read(startByte, endByte);
    const fetchedBytes = bytes?.byteLength ?? 0;
    if (fetchedBytes < 1024) throw new Error('short-range');

    const decoded = await ctx.decodeAudioData(bytes);
    const skip = Math.min(
      Math.round(PREROLL_SECONDS * decoded.sampleRate),
      Math.max(decoded.length - 1, 0),
    );
    const buffer = reverseFragment(ctx, decoded, skip);
    if (!buffer) throw new Error('empty-fragment');

    // VBR means the byte estimate can decode slightly more or less than 20 s;
    // centre the decoded fragment on the playhead so the ±8 s window stays
    // symmetric instead of trusting the byte ratio for the start time.
    const length = buffer.duration;
    const segmentStart = clamp(
      center - length / 2,
      0,
      Math.max(total - length, 0),
    );
    const segmentEnd = Math.min(segmentStart + length, total);
    return { buffer, segmentStart, segmentEnd };
  }

  async function buildWhole({ ctx, byteSource, total }) {
    if (total > MAX_WHOLE_SECONDS) throw Object.assign(new Error('long'), { code: 'long' });
    if (!byteSource) throw new Error('no-source');
    const bytes = await byteSource.read(0, Infinity, true);
    const fetchedBytes = bytes?.byteLength ?? 0;
    if (fetchedBytes < 1024) throw new Error('short-whole');
    const decoded = await ctx.decodeAudioData(bytes);
    const buffer = downsampleReversed(ctx, decoded);
    return { buffer, segmentStart: 0, segmentEnd: Math.min(buffer.duration, total) };
  }

  async function build({ audio, trackId, ctx, duration, center, byteSource, gestureId, buildEpoch }) {
    const total = Number(duration) || Number(audio?.duration) || 0;
    if (!(total > 0)) return { ok: false, code: 'decode' };
    const position = clamp(Number(center) || Number(audio?.currentTime) || 0, 0, total);

    const accept = (built) => {
      if (buildEpoch !== epoch) return { ok: false, code: 'cancelled' };
      cache = { trackId, ...built };
      cursor = clamp(position, built.segmentStart, built.segmentEnd);
      failure = null;
      exhausted = null;
      return { ok: true };
    };

    let rangeError = null;
    try {
      return accept(await buildRange({ ctx, byteSource, center: position, total }));
    } catch (error) {
      rangeError = String(error?.message ?? error);
    }

    try {
      return accept(await buildWhole({ ctx, byteSource, total }));
    } catch (error) {
      const code = total > MAX_WHOLE_SECONDS ? 'long' : rangeError ? 'range' : 'decode';
      failure = { trackId, gestureId, code };
      return { ok: false, code };
    }
  }

  /**
   * Make sure a reversed window covers the gesture centre.
   * @returns {{ status: 'ready'|'loading'|'fallback', code?: string, promise?: Promise<object> }}
   */
  function ensure({ audio, trackId, ctx, duration, center, byteSource, gestureId = 0 }) {
    const id = trackId ?? null;
    if (cache && cache.trackId === id) {
      const value = Number(center) || Number(audio?.currentTime) || 0;
      if (value >= cache.segmentStart + 0.1 && value <= cache.segmentEnd - 0.1) {
        return { status: 'ready' };
      }
      cache = null;
    }
    if (failure && failure.trackId === id && failure.gestureId === gestureId) {
      return { status: 'fallback', code: failure.code };
    }
    if (pending && pending.trackId === id && pending.gestureId === gestureId) {
      return { status: 'loading', promise: pending.promise };
    }
    if (cache && cache.trackId !== id) cache = null;
    let promise;
    promise = build({
      audio,
      trackId: id,
      ctx,
      duration,
      center,
      byteSource,
      gestureId,
      buildEpoch: epoch,
    })
      .catch(() => ({ ok: false, code: 'decode' }))
      .finally(() => {
        if (pending?.promise === promise) pending = null;
      });
    pending = { trackId: id, gestureId, promise };
    return { status: 'loading', promise };
  }

  /** Start the reversed window once, then just retarget its rate. */
  function play({ ctx, destination, audio, speed, trackId, gestureId = 0, onEnded }) {
    if (!cache || !ctx || !destination) return false;
    if (exhausted && exhausted.trackId === trackId && exhausted.gestureId === gestureId) return false;
    const rate = Number(
      clamp(clamp01(speed / SPEED_REF) * 2.4 + 0.6, RATE_MIN, RATE_MAX).toFixed(3),
    );
    if (source && source.context === ctx) {
      advance();
      currentRate = rate;
      source.playbackRate.setTargetAtTime(rate, ctx.currentTime, 0.02);
      return true;
    }
    stop();
    const position = clamp(Number(audio?.currentTime) || 0, cache.segmentStart, cache.segmentEnd);
    const offset = clamp(cache.segmentEnd - position, 0, Math.max(cache.buffer.duration - 0.001, 0));
    let node;
    try {
      node = ctx.createBufferSource();
      node.buffer = cache.buffer;
      node.loop = false;
      node.playbackRate.value = rate;
      node.connect(destination);
      node.start(0, offset);
      cursor = cache.segmentEnd - offset;
      lastAt = ctx.currentTime;
      currentRate = rate;
    } catch {
      try {
        node?.disconnect();
      } catch {
        // already gone
      }
      return false;
    }
    node.onended = () => {
      if (source !== node) return;
      source = null;
      cursor = cache?.segmentStart ?? 0;
      try {
        node.disconnect();
      } catch {
        // already disconnected
      }
      exhausted = { trackId, gestureId };
      onEnded?.({ position: cache?.segmentStart ?? 0 });
    };
    source = node;
    return true;
  }

  function stop() {
    if (!source) return;
    advance();
    const node = source;
    source = null;
    try {
      node.onended = null;
    } catch {
      // no handler to clear
    }
    try {
      node.stop();
    } catch {
      // already stopped
    }
    try {
      node.disconnect();
    } catch {
      // already disconnected
    }
  }

  function state() {
    if (source) advance();
    return {
      cached: Boolean(cache),
      sourceActive: Boolean(source),
      // Original-time playhead: decreases while the window is scratched back.
      offset: Number(cursor.toFixed(3)),
    };
  }

  return {
    ensure,
    play,
    stop,
    release,
    state,
    hasWindow,
  };
}
