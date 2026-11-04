/**
 * LRC parsing helpers. Pure functions over strings; sidecar bytes are decoded
 * with the same legacy fallback the ID3 reader uses, because `.lrc` files in
 * the wild are often GBK or Shift_JIS.
 */

import { decodeLegacyText } from '../metadata/id3.js';

const META_TAG = /\[(ar|ti|al|by|offset|length|re|ve|tool):[^\]]*\]/gi;
const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?(?:\.(\d{1,3}))?\]/g;
const OFFSET_TAG = /\[offset:\s*([+-]?\d+)\s*\]/gi;
// Enhanced LRC word timings are dropped: `<m:ss.xx>` and friends.
const WORD_TAG = /<\d+:\d{1,2}(?::\d{1,2})?(?:\.\d{1,3})?>/g;
// Non-global twin used for tests so no `lastIndex` state leaks between lines.
const META_PRESENT = /\[(ar|ti|al|by|offset|length|re|ve|tool):[^\]]*\]/i;

function normalize(text) {
  return String(text ?? '')
    .replace(/^\ufeff/, '')
    .replace(/\r\n?/g, '\n');
}

function secondsOf(match) {
  const hours = match[3] === undefined ? 0 : Number(match[1]);
  const minutes = match[3] === undefined ? Number(match[1]) : Number(match[2]);
  const seconds = match[3] === undefined ? Number(match[2]) : Number(match[3]);
  const fraction = match[4] === undefined ? 0 : Number(`0.${match[4]}`);
  return hours * 3600 + minutes * 60 + seconds + fraction;
}

/**
 * @param {string} text
 * @returns {{offset:number, lines:Array<{time:number,text:string}>, plain:string}}
 */
export function parseLrc(text) {
  const source = normalize(text);
  const timed = [];
  const untimed = [];
  let offsetMs = 0;
  let order = 0;

  for (const raw of source.split('\n')) {
    if (!raw.trim()) continue;

    for (const match of raw.matchAll(OFFSET_TAG)) {
      const value = Number(match[1]);
      if (Number.isFinite(value)) offsetMs = value;
    }

    const tags = [...raw.matchAll(TIME_TAG)];
    const body = raw
      .replace(TIME_TAG, '')
      .replace(META_TAG, '')
      .replace(WORD_TAG, '')
      .trim();

    if (!tags.length) {
      if (!META_PRESENT.test(raw) && body) untimed.push(raw.trim());
      continue;
    }
    if (!body) continue;
    for (const tag of tags) {
      timed.push({ time: secondsOf(tag), text: body, order: order++ });
    }
  }

  const seconds = offsetMs / 1000;
  timed.sort((a, b) => a.time - b.time || a.order - b.order);
  const lines = timed.map((item) => ({ time: Math.max(0, item.time + seconds), text: item.text }));
  return { offset: offsetMs, lines, plain: lines.length ? '' : untimed.join('\n') };
}

/**
 * Index of the last line whose `time` is at or before `position`; binary search.
 * @param {Array<{time:number}>} lines
 * @param {number} position seconds
 * @returns {number}
 */
export function activeLineIndex(lines, position) {
  const list = Array.isArray(lines) ? lines : [];
  const target = Number(position);
  if (!list.length || !Number.isFinite(target) || target < list[0].time) return -1;
  let low = 0;
  let high = list.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (list[mid].time <= target) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * UTF-8 first (BOM stripped), then the legacy code-page heuristic. Any input
 * that cannot be decoded yields an empty string rather than throwing.
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView} bytes
 * @returns {string}
 */
export function decodeLyricsBytes(bytes) {
  try {
    let view = null;
    if (bytes instanceof Uint8Array) view = bytes;
    else if (bytes instanceof ArrayBuffer) view = new Uint8Array(bytes);
    else if (ArrayBuffer.isView(bytes)) {
      view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    if (!view) return '';
    if (view.length >= 3 && view[0] === 0xef && view[1] === 0xbb && view[2] === 0xbf) {
      view = view.subarray(3);
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(view);
    } catch {
      return decodeLegacyText(view);
    }
  } catch {
    return '';
  }
}

/**
 * Same-directory lyric candidates for a track path, preferred order.
 * @param {string} path
 * @returns {string[]}
 */
export function sidecarCandidates(path) {
  const raw = String(path ?? '');
  const slash = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'));
  const dot = raw.lastIndexOf('.');
  const base = dot > slash ? raw.slice(0, dot) : raw;
  if (!base || base === '/' || base === '\\') return [];
  return [`${base}.lrc`, `${base}.LRC`];
}
