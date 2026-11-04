/**
 * ReplayGain parsing and gain-factor maths.
 * Pure functions: no DOM, no timers, no I/O.
 */

const MAX_DB = 24;
const MIN_FACTOR = 0.1;
const MAX_FACTOR = 4;

/** Number with an optional sign and an optional `dB` suffix. */
const DB_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*(?:db)?$/i;
const PEAK_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const HEX_WORD = /^[0-9a-f]{8}$/i;

/**
 * Parse a ReplayGain value such as `-7.25 dB` or `+3.0 dB`.
 * Out-of-range values clamp to ±24 dB; anything else yields null.
 * @param {unknown} value
 * @returns {number|null}
 */
export function parseGainDb(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || !DB_PATTERN.test(text)) return null;
  const db = Number.parseFloat(text);
  if (!Number.isFinite(db)) return null;
  return Math.min(Math.max(db, -MAX_DB), MAX_DB);
}

/**
 * Decibels to linear factor, clamped to [0.1, 4].
 * @param {number} db
 * @returns {number}
 */
export function gainFactor(db) {
  if (!Number.isFinite(db)) return 1;
  const factor = 10 ** (db / 20);
  return Math.min(Math.max(factor, MIN_FACTOR), MAX_FACTOR);
}

/**
 * Decode an iTunNORM payload into the raw 32-bit words.
 * Diagnostic only: these values never feed the gain.
 * @param {unknown} value
 * @returns {number[]|null}
 */
export function parseItunNorm(value) {
  if (typeof value !== 'string') return null;
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length < 4) return null;
  const out = [];
  for (const word of words) {
    if (!HEX_WORD.test(word)) return null;
    out.push(Number.parseInt(word, 16));
  }
  return out;
}

/**
 * Choose the gain to apply for one track's tags.
 * @param {{trackGainDb?: number}} [tags]
 * @param {{enabled?: boolean}} [options]
 * @returns {{db: number|null, factor: number, reason: 'off'|'none'|'tag'}}
 */
export function decideGain(tags, { enabled = false } = {}) {
  if (!enabled) return { db: null, factor: 1, reason: 'off' };
  const db = tags?.trackGainDb;
  if (!Number.isFinite(db)) return { db: null, factor: 1, reason: 'none' };
  return { db, factor: gainFactor(db), reason: 'tag' };
}
