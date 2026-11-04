import test from 'node:test';
import assert from 'node:assert/strict';

import { parseId3 } from '../src/core/metadata/id3.js';

/** ID3v2.3 syncsafe integer, 4 bytes big-endian with the top bit clear. */
function syncsafe(value) {
  return new Uint8Array([
    (value >> 21) & 0x7f,
    (value >> 14) & 0x7f,
    (value >> 7) & 0x7f,
    value & 0x7f,
  ]);
}

/** One ID3v2.3 text frame: 4-byte id, big-endian size, 2 flag bytes, payload. */
function textFrame(id, encoding, textBytes) {
  const payload = new Uint8Array(1 + textBytes.length);
  payload[0] = encoding;
  payload.set(textBytes, 1);
  const frame = new Uint8Array(10 + payload.length);
  for (let i = 0; i < 4; i += 1) frame[i] = id.charCodeAt(i);
  const size = payload.length;
  frame[4] = (size >>> 24) & 0xff;
  frame[5] = (size >>> 16) & 0xff;
  frame[6] = (size >>> 8) & 0xff;
  frame[7] = size & 0xff;
  // frame[8], frame[9]: status/format flags, both zero.
  frame.set(payload, 10);
  return frame;
}

/** Whole ID3v2.3 tag (10-byte header + frames, no padding). */
function id3v23(frames) {
  const framesLength = frames.reduce((sum, frame) => sum + frame.length, 0);
  const tag = new Uint8Array(10 + framesLength);
  tag[0] = 0x49; // I
  tag[1] = 0x44; // D
  tag[2] = 0x33; // 3
  tag[3] = 3; // version 2.3
  tag[4] = 0; // revision
  tag[5] = 0; // flags
  tag.set(syncsafe(framesLength), 6);
  let cursor = 10;
  for (const frame of frames) {
    tag.set(frame, cursor);
    cursor += frame.length;
  }
  return tag;
}

/** UTF-16BE bytes; Node ships no utf16be encoder. */
function utf16be(text) {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i += 1) {
    const cp = text.charCodeAt(i);
    out[i * 2] = (cp >> 8) & 0xff;
    out[i * 2 + 1] = cp & 0xff;
  }
  return out;
}

function utf16le(text) {
  return new Uint8Array(Buffer.from(text, 'utf16le'));
}

function concat(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

const BOM_LE = new Uint8Array([0xff, 0xfe]);
const BOM_BE = new Uint8Array([0xfe, 0xff]);

test('encoding 1, FF FE little-endian BOM decodes title in LE', () => {
  const tag = id3v23([textFrame('TIT2', 1, concat(BOM_LE, utf16le('Hitomi Takahashi')))]);
  const meta = parseId3(tag);
  assert.equal(meta.title, 'Hitomi Takahashi');
  // Byte-swapped reading of the same bytes must not be what comes back.
  assert.notEqual(meta.title, '䠀椀琀漀洀椀 吀愀欀愀栀愀猀栀椀');
});

test('encoding 1, FF FE little-endian BOM decodes Japanese artist in LE', () => {
  const tag = id3v23([textFrame('TPE1', 1, concat(BOM_LE, utf16le('ココロのちず')))]);
  const meta = parseId3(tag);
  assert.equal(meta.artist, 'ココロのちず');
});

test('encoding 1, FF FE little-endian BOM decodes ASCII title', () => {
  const tag = id3v23([textFrame('TIT2', 1, concat(BOM_LE, utf16le('StarRingChild')))]);
  const meta = parseId3(tag);
  assert.equal(meta.title, 'StarRingChild');
});

test('encoding 1, FE FF big-endian BOM decodes Japanese title in BE', () => {
  const tag = id3v23([textFrame('TIT2', 1, concat(BOM_BE, utf16be('奈落の花')))]);
  const meta = parseId3(tag);
  assert.equal(meta.title, '奈落の花');
});

test('encoding 2 without BOM decodes big-endian title', () => {
  const tag = id3v23([textFrame('TIT2', 2, utf16be('奈落の花'))]);
  const meta = parseId3(tag);
  assert.equal(meta.title, '奈落の花');
});

test('encoding 1 without BOM defaults to little-endian', () => {
  const tag = id3v23([textFrame('TIT2', 1, utf16le('Hitomi'))]);
  const meta = parseId3(tag);
  assert.equal(meta.title, 'Hitomi');
});
