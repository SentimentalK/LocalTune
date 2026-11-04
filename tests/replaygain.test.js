import test from 'node:test';
import assert from 'node:assert/strict';

import { parseReplayGain } from '../src/core/metadata/id3.js';

const encoder = new TextEncoder();

function concat(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function syncsafe(value) {
  return Uint8Array.of(
    (value >> 21) & 0x7f,
    (value >> 14) & 0x7f,
    (value >> 7) & 0x7f,
    value & 0x7f,
  );
}

/** Build a TXXX frame; only the one-byte encodings are exercised here. */
function txxx(description, value, { version = 3, encoding = 0 } = {}) {
  assert.ok(encoding === 0 || encoding === 3, 'encoding 0 or 3 only');
  const desc = encoder.encode(description);
  const text = encoder.encode(value);
  const payload = new Uint8Array(1 + desc.length + 1 + text.length);
  payload[0] = encoding;
  payload.set(desc, 1);
  payload.set(text, 1 + desc.length + 1);

  const frame = new Uint8Array(10 + payload.length);
  frame.set(encoder.encode('TXXX'), 0);
  const size = payload.length;
  if (version >= 4) {
    frame.set(syncsafe(size), 4);
  } else {
    frame.set([(size >>> 24) & 0xff, (size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff], 4);
  }
  frame.set(payload, 10);
  return frame;
}

function textFrame(id, value, { version = 3, encoding = 0 } = {}) {
  const payload = concat([Uint8Array.of(encoding), encoder.encode(value)]);
  const frame = new Uint8Array(10 + payload.length);
  frame.set(encoder.encode(id), 0);
  const size = payload.length;
  if (version >= 4) frame.set(syncsafe(size), 4);
  else frame.set([(size >>> 24) & 0xff, (size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff], 4);
  frame.set(payload, 10);
  return frame;
}

function id3(frames, { version = 3 } = {}) {
  const body = concat(frames);
  const header = new Uint8Array(10);
  header.set([0x49, 0x44, 0x33, version, 0, 0]);
  header.set(syncsafe(body.length), 6);
  return concat([header, body]);
}

const ITUN_NORM = '0000012C 0000012C 0000B5C8 0000B5C8 0000012C 0000012C 00000000 00000000';

test('v2.3 TXXX frames with encoding 0 expose every ReplayGain field', () => {
  const bytes = id3([
    txxx('REPLAYGAIN_TRACK_GAIN', '-7.25 dB'),
    txxx('REPLAYGAIN_TRACK_PEAK', '0.98'),
    txxx('REPLAYGAIN_ALBUM_GAIN', '+2.0 dB'),
    txxx('iTunNORM', ITUN_NORM),
  ]);
  const parsed = parseReplayGain(bytes);
  assert.equal(parsed.present, true);
  assert.equal(parsed.trackGainDb, -7.25);
  assert.equal(parsed.trackPeak, 0.98);
  assert.equal(parsed.albumGainDb, 2);
  assert.deepEqual(parsed.itunNorm, [
    0x12c,
    0x12c,
    0xb5c8,
    0xb5c8,
    0x12c,
    0x12c,
    0,
    0,
  ]);
});

test('v2.4 TXXX frames with UTF-8 encoding and lowercase descriptions parse', () => {
  const bytes = id3(
    [
      txxx('replaygain_track_gain', '-3.5 dB', { version: 4, encoding: 3 }),
      txxx('replaygain_track_peak', '1.000000', { version: 4, encoding: 3 }),
      txxx('REPLAYGAIN_ALBUM_GAIN', '-1.25', { version: 4, encoding: 3 }),
    ],
    { version: 4 },
  );
  const parsed = parseReplayGain(bytes);
  assert.equal(parsed.present, true);
  assert.equal(parsed.trackGainDb, -3.5);
  assert.equal(parsed.trackPeak, 1);
  assert.equal(parsed.albumGainDb, -1.25);
  assert.equal(parsed.itunNorm, null);
});

test('out-of-range gains clamp to plus or minus 24 dB', () => {
  const bytes = id3([
    txxx('REPLAYGAIN_TRACK_GAIN', '-40 dB'),
    txxx('REPLAYGAIN_ALBUM_GAIN', '+30 dB'),
  ]);
  const parsed = parseReplayGain(bytes);
  assert.equal(parsed.trackGainDb, -24);
  assert.equal(parsed.albumGainDb, 24);
});

test('non-TXXX frames alone leave the tag absent', () => {
  const bytes = id3([textFrame('TIT2', 'Song'), textFrame('TPE1', 'Artist')]);
  assert.deepEqual(parseReplayGain(bytes), {
    present: false,
    trackGainDb: null,
    trackPeak: null,
    albumGainDb: null,
    itunNorm: null,
  });
});

test('unknown TXXX descriptions are ignored', () => {
  const bytes = id3([txxx('REPLAYGAIN_REFERENCE_LOUDNESS', '89.0 dB'), txxx('MOOD', 'calm')]);
  const parsed = parseReplayGain(bytes);
  assert.equal(parsed.present, false);
  assert.equal(parsed.trackGainDb, null);
  assert.equal(parsed.itunNorm, null);
});

test('an iTunNORM with too few words is null but still marked present', () => {
  const bytes = id3([txxx('iTunNORM', '0000012C 0000012C')]);
  const parsed = parseReplayGain(bytes);
  assert.equal(parsed.present, true);
  assert.equal(parsed.itunNorm, null);
});

test('empty and non-ID3 buffers return the all-null shape', () => {
  const empty = { present: false, trackGainDb: null, trackPeak: null, albumGainDb: null, itunNorm: null };
  assert.deepEqual(parseReplayGain(new Uint8Array(0)), empty);
  assert.deepEqual(parseReplayGain(new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0, 0, 0, 0])), empty);
  assert.deepEqual(parseReplayGain(null), empty);
  assert.deepEqual(parseReplayGain(undefined), empty);
});

test('a tag with no frames returns the all-null shape', () => {
  const header = new Uint8Array(10);
  header.set([0x49, 0x44, 0x33, 3, 0, 0]);
  assert.deepEqual(parseReplayGain(header), {
    present: false,
    trackGainDb: null,
    trackPeak: null,
    albumGainDb: null,
    itunNorm: null,
  });
});
