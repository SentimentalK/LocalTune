/**
 * Deterministic fixture generator for the metadata tests.
 *
 *   node tests/fixtures/gen.mjs
 *
 * Writes sample.mp3 (ID3v2.3 + Xing frame count) and sample.m4a
 * (ftyp + moov[mvhd + udta/meta/ilst] + mdat) next to this script.
 * No external assets or network access; re-running produces identical bytes.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const OUT_DIR = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ PNG -- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

function makePng(width, height, rgb) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const row = Buffer.from([0, rgb[0], rgb[1], rgb[2]]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const idat = deflateSync(raw);
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ ID3 -- */

function syncsafe(value) {
  return Buffer.from([(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f]);
}

function id3TextFrame(id, text) {
  const payload = Buffer.concat([Buffer.from([0x00]), Buffer.from(text, 'latin1')]);
  const header = Buffer.alloc(10);
  header.write(id, 0, 'latin1');
  header.writeUInt32BE(payload.length, 4);
  header.writeUInt16BE(0, 8);
  return Buffer.concat([header, payload]);
}

function id3ApicFrame(mime, pictureType, image) {
  const payload = Buffer.concat([
    Buffer.from([0x00]),
    Buffer.from(mime, 'latin1'),
    Buffer.from([0x00, pictureType, 0x00]),
    image,
  ]);
  const header = Buffer.alloc(10);
  header.write('APIC', 0, 'latin1');
  header.writeUInt32BE(payload.length, 4);
  header.writeUInt16BE(0, 8);
  return Buffer.concat([header, payload]);
}

function buildId3v23() {
  const cover = makePng(1, 1, [210, 90, 60]);
  const frames = Buffer.concat([
    id3TextFrame('TIT2', 'Night Drive'),
    id3TextFrame('TPE1', 'Core Worker'),
    id3TextFrame('TALB', 'Test Album'),
    id3TextFrame('TYER', '2001'),
    id3TextFrame('TRCK', '3/10'),
    id3ApicFrame('image/png', 0x03, cover),
  ]);
  const header = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00]);
  return Buffer.concat([header, syncsafe(frames.length), frames]);
}

/* ----------------------------------------------------------------- MP3 -- */

const MPEG_HEADER = Buffer.from([0xff, 0xfb, 0x90, 0x00]); // MPEG1 L3, 128 kbps, 44.1 kHz
const MPEG_FRAME_LENGTH = Math.floor((144 * 128000) / 44100); // 417
const XING_OFFSET = 4 + 32; // header + MPEG1 stereo side info
const AUDIO_FRAMES = 100;

function buildMp3() {
  const tag = buildId3v23();
  const frames = [];

  const xing = Buffer.alloc(MPEG_FRAME_LENGTH);
  MPEG_HEADER.copy(xing, 0);
  xing.write('Xing', XING_OFFSET, 'latin1');
  xing.writeUInt32BE(0x01, XING_OFFSET + 4); // flags: frame count present
  xing.writeUInt32BE(AUDIO_FRAMES, XING_OFFSET + 8);
  frames.push(xing);

  for (let i = 0; i < AUDIO_FRAMES; i += 1) {
    const frame = Buffer.alloc(MPEG_FRAME_LENGTH);
    MPEG_HEADER.copy(frame, 0);
    frames.push(frame);
  }

  return Buffer.concat([tag, ...frames]);
}

/* ----------------------------------------------------------------- MP4 -- */

function atom(type, ...payloads) {
  const body = Buffer.concat(payloads);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, body]);
}

function fullBox(type, version, flags, ...payloads) {
  const vf = Buffer.alloc(4);
  vf[0] = version;
  vf.writeUIntBE(flags >>> 0, 1, 3);
  return atom(type, vf, ...payloads);
}

function dataAtom(type, payload) {
  const typeBytes = Buffer.alloc(4);
  typeBytes.writeUInt32BE(type, 0);
  return atom('data', typeBytes, Buffer.alloc(4), payload);
}

function textEntry(name, value) {
  return atom(name, dataAtom(1, Buffer.from(value, 'utf8')));
}

const MVHD_DURATION = 31234; // ms
const MVHD_TIMESCALE = 1000;

function buildMvhd() {
  const payload = Buffer.alloc(100);
  payload.writeUInt32BE(0, 0); // version 0 + flags
  payload.writeUInt32BE(0, 4); // creation time
  payload.writeUInt32BE(0, 8); // modification time
  payload.writeUInt32BE(MVHD_TIMESCALE, 12);
  payload.writeUInt32BE(MVHD_DURATION, 16);
  payload.writeUInt32BE(0x00010000, 20); // rate
  payload.writeUInt16BE(0x0100, 24); // volume
  // reserved, matrix, pre_defined and next_track_ID stay zeroed
  return atom('mvhd', payload);
}

function buildHdlr() {
  return fullBox('hdlr', 0, 0, Buffer.from('mdirappl\0\0\0\0\0\0\0\0\0', 'latin1'));
}

function buildIlst() {
  const cover = makePng(2, 2, [40, 120, 200]);
  const track = Buffer.from([0x00, 0x00, 0x00, 0x07, 0x00, 0x0c, 0x00, 0x00]);
  return atom(
    'ilst',
    textEntry('\u00a9nam', 'Fixture Song'),
    textEntry('\u00a9ART', 'Fixture Artist'),
    textEntry('\u00a9alb', 'Fixture Album'),
    textEntry('\u00a9day', '2019-05-17'),
    atom('trkn', dataAtom(0, track)),
    atom('covr', dataAtom(14, cover)),
  );
}

function buildMp4() {
  const ftyp = atom(
    'ftyp',
    Buffer.from('M4A ', 'latin1'),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from('M4A ', 'latin1'),
    Buffer.from('mp42', 'latin1'),
    Buffer.from('isom', 'latin1'),
  );
  const meta = fullBox('meta', 0, 0, buildHdlr(), buildIlst());
  const moov = atom('moov', buildMvhd(), atom('udta', meta));
  const mdat = atom('mdat', Buffer.alloc(4096, 0x11));
  return Buffer.concat([ftyp, moov, mdat]);
}

/* ----------------------------------------------------------------- run -- */

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const mp3 = buildMp3();
  const m4a = buildMp4();
  if (mp3.length + m4a.length > 200 * 1024) {
    throw new Error('fixtures exceed 200 KB');
  }
  writeFileSync(join(OUT_DIR, 'sample.mp3'), mp3);
  writeFileSync(join(OUT_DIR, 'sample.m4a'), m4a);
  console.log(`sample.mp3 ${mp3.length} bytes, sample.m4a ${m4a.length} bytes`);
}

main();
