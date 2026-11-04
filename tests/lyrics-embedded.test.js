import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readEmbeddedLyrics } from '../src/core/lyrics/embedded.js';
import { resolveLyrics } from '../src/core/lyrics/index.js';

/* ---------- fixture builders ---------- */

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

function asciiBytes(text) {
  return Uint8Array.from([...text].map((char) => char.charCodeAt(0) & 0xff));
}

function utf8(text) {
  return new TextEncoder().encode(text);
}

function latin1(text) {
  return Uint8Array.from([...text].map((char) => char.charCodeAt(0) & 0xff));
}

function utf16(text, { little = true, bom = true } = {}) {
  const bytes = new Uint8Array(Buffer.from(text, 'utf16le'));
  if (!little) {
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const swap = bytes[i];
      bytes[i] = bytes[i + 1];
      bytes[i + 1] = swap;
    }
  }
  if (!bom) return bytes;
  return concat([Uint8Array.of(...(little ? [0xff, 0xfe] : [0xfe, 0xff])), bytes]);
}

function u32(value) {
  return Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function syncsafeBytes(value) {
  return Uint8Array.of(
    (value >>> 21) & 0x7f,
    (value >>> 14) & 0x7f,
    (value >>> 7) & 0x7f,
    value & 0x7f,
  );
}

function terminator(encoding) {
  return encoding === 1 || encoding === 2 ? Uint8Array.of(0, 0) : Uint8Array.of(0);
}

function textBytes(text, encoding) {
  if (encoding === 0) return latin1(text);
  if (encoding === 1) return utf16(text);
  if (encoding === 2) return utf16(text, { little: false, bom: false });
  return utf8(text);
}

function usltBody(text, encoding = 3) {
  return concat([
    Uint8Array.of(encoding),
    asciiBytes('eng'),
    terminator(encoding),
    textBytes(text, encoding),
  ]);
}

function syltBody(entries, { encoding = 3, format = 2 } = {}) {
  const parts = [
    Uint8Array.of(encoding),
    asciiBytes('eng'),
    Uint8Array.of(format, 1),
    terminator(encoding),
  ];
  for (const entry of entries) {
    parts.push(textBytes(entry.text, encoding), terminator(encoding), u32(entry.ms));
  }
  return concat(parts);
}

function frame(id, body, { major = 3, compressed = false } = {}) {
  const size = major === 4 ? syncsafeBytes(body.length) : u32(body.length);
  const flags = compressed
    ? major === 4
      ? Uint8Array.of(0, 0x08)
      : Uint8Array.of(0, 0x80)
    : Uint8Array.of(0, 0);
  return concat([asciiBytes(id), size, flags, body]);
}

function id3Tag(frames, major = 3) {
  const body = concat(frames);
  return concat([asciiBytes('ID3'), Uint8Array.of(major, 0, 0), syncsafeBytes(body.length), body]);
}

function mp3File(...args) {
  return new File([id3Tag(...args)], 'song.mp3');
}

function atom(type, payload) {
  return concat([u32(payload.length + 8), asciiBytes(type), payload]);
}

function m4aFile(text) {
  const data = atom('data', concat([u32(1), u32(0), utf8(text)]));
  const ilst = atom('ilst', atom('\u00a9lyr', data));
  const meta = atom('meta', concat([u32(0), ilst]));
  const moov = atom('moov', atom('udta', meta));
  return new File([concat([atom('ftyp', asciiBytes('M4A ')), moov])], 'song.m4a');
}

function assertEmpty(result) {
  assert.deepEqual(result.synced, []);
  assert.equal(result.plain, '');
}

/* ---------- mp3 ---------- */

test('embedded mp3: ID3v2.3 USLT encoding 0', async () => {
  const file = mp3File([frame('USLT', usltBody('plain latin', 0))]);
  assert.deepEqual(await readEmbeddedLyrics(file), { synced: [], plain: 'plain latin' });
});

test('embedded mp3: ID3v2.3 USLT encoding 1 with UTF-16 BOM', async () => {
  const file = mp3File([frame('USLT', usltBody('你好世界', 1))]);
  assert.equal((await readEmbeddedLyrics(file)).plain, '你好世界');
});

test('embedded mp3: ID3v2.3 USLT encoding 2 UTF-16BE', async () => {
  const file = mp3File([frame('USLT', usltBody('big endian', 2))]);
  assert.equal((await readEmbeddedLyrics(file)).plain, 'big endian');
});

test('embedded mp3: USLT encoding 3 keeps line breaks and joins frames in order', async () => {
  const file = mp3File([
    frame('USLT', usltBody('first\nline', 3)),
    frame('USLT', usltBody('second', 3)),
  ]);
  assert.equal((await readEmbeddedLyrics(file)).plain, 'first\nline\nsecond');
});

test('embedded mp3: SYLT format 2 is converted to seconds and sorted', async () => {
  const file = mp3File([
    frame(
      'SYLT',
      syltBody([
        { text: 'later', ms: 2500 },
        { text: 'earlier', ms: 500 },
      ]),
    ),
  ]);
  const result = await readEmbeddedLyrics(file);
  assert.deepEqual(result.synced, [
    { time: 0.5, text: 'earlier' },
    { time: 2.5, text: 'later' },
  ]);
  assert.equal(result.plain, '');
});

test('embedded mp3: SYLT format 1 is ignored entirely', async () => {
  const file = mp3File([frame('SYLT', syltBody([{ text: 'frame-counted', ms: 10 }], { format: 1 }))]);
  assertEmpty(await readEmbeddedLyrics(file));
});

test('embedded mp3: ID3v2.4 uses syncsafe frame sizes', async () => {
  const text = 'x'.repeat(200);
  const file = mp3File([frame('USLT', usltBody(text, 3), { major: 4 })], 4);
  const result = await readEmbeddedLyrics(file);
  assert.equal(result.plain, text);
});

test('embedded mp3: compressed frames are skipped', async () => {
  const file = mp3File([
    frame('USLT', usltBody('compressed', 3), { compressed: true }),
    frame('USLT', usltBody('kept', 3)),
  ]);
  assert.equal((await readEmbeddedLyrics(file)).plain, 'kept');
});

test('embedded mp3: malformed or unsupported tags return empty', async () => {
  assertEmpty(await readEmbeddedLyrics(new File([new Uint8Array(4)], 'broken.mp3')));
  assertEmpty(await readEmbeddedLyrics(new File([asciiBytes('ID3\u0002\u0000\u0000')], 'old.mp3')));
  assertEmpty(await readEmbeddedLyrics(new File([new Uint8Array([0x49, 0x44, 0x33])], 'short.mp3')));
});

/* ---------- m4a ---------- */

test('embedded m4a: ©lyr inside moov/udta/meta/ilst', async () => {
  const file = m4aFile('m4a lyrics\nsecond line');
  assert.deepEqual(await readEmbeddedLyrics(file), { synced: [], plain: 'm4a lyrics\nsecond line' });
});

test('embedded: unsupported extension and junk m4a return empty', async () => {
  assertEmpty(await readEmbeddedLyrics(new File([utf8('[00:01]x')], 'lyrics.lrc')));
  assertEmpty(await readEmbeddedLyrics(new File([new Uint8Array(64)], 'broken.m4a')));
});

/* ---------- source priority through resolveLyrics ---------- */

function fakeGetFile(map) {
  return async (path) => {
    if (!(path in map)) throw new Error(`missing ${path}`);
    const value = map[path];
    return typeof value === 'function' ? value() : value;
  };
}

test('resolve priority: sidecar .lrc wins over embedded USLT', async () => {
  const track = { path: 'Music/song.mp3' };
  const embedded = mp3File([frame('USLT', usltBody('embedded', 3))]);
  const result = await resolveLyrics({
    track,
    getFile: fakeGetFile({
      'Music/song.lrc': utf8('[00:01]sidecar'),
      'Music/song.mp3': embedded,
    }),
  });
  assert.equal(result.source, 'lrc');
  assert.deepEqual(result.lines.map((line) => line.text), ['sidecar']);
});

test('resolve priority: .LRC is used when .lrc is missing', async () => {
  const track = { path: 'Music/song.mp3' };
  const result = await resolveLyrics({
    track,
    getFile: fakeGetFile({
      'Music/song.LRC': utf8('[00:02]upper'),
      'Music/song.mp3': mp3File([frame('USLT', usltBody('embedded', 3))]),
    }),
  });
  assert.equal(result.source, 'lrc');
  assert.equal(result.lines[0].text, 'upper');
});

test('resolve priority: an empty sidecar falls back to embedded lyrics', async () => {
  const track = { path: 'Music/song.mp3' };
  const result = await resolveLyrics({
    track,
    getFile: fakeGetFile({
      'Music/song.lrc': utf8('[ti:only metadata]'),
      'Music/song.mp3': mp3File([frame('USLT', usltBody('embedded wins', 3))]),
    }),
  });
  assert.equal(result.source, 'uslt');
  assert.equal(result.plain, 'embedded wins');
});

test('resolve priority: SYLT beats USLT in the same file', async () => {
  const track = { path: 'Music/song.mp3' };
  const file = mp3File([
    frame('USLT', usltBody('plain text', 3)),
    frame('SYLT', syltBody([{ text: 'synced', ms: 1500 }])),
  ]);
  const result = await resolveLyrics({ track, getFile: fakeGetFile({ 'Music/song.mp3': file }) });
  assert.equal(result.source, 'sylt');
  assert.deepEqual(result.lines, [{ time: 1.5, text: 'synced' }]);
});
