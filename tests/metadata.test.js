import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readMetadata } from '../src/core/metadata/index.js';
import { parseId3, decodeLegacyText } from '../src/core/metadata/id3.js';
import { parseMp4 } from '../src/core/metadata/mp4.js';

const FIXTURES = new URL('./fixtures/', import.meta.url);

async function fixtureFile(name) {
  const bytes = await readFile(fileURLToPath(new URL(name, FIXTURES)));
  return new File([bytes], name);
}

test('mp3: ID3v2.3 text frames, track number, cover and Xing duration', async () => {
  const meta = await readMetadata(await fixtureFile('sample.mp3'));
  assert.equal(meta.title, 'Night Drive');
  assert.equal(meta.artist, 'Core Worker');
  assert.equal(meta.album, 'Test Album');
  assert.equal(meta.year, 2001);
  assert.equal(meta.trackNo, 3);

  const expected = (100 * 1152) / 44100;
  assert.ok(Math.abs(meta.duration - expected) <= 0.02, `duration ${meta.duration} vs ${expected}`);

  assert.ok(meta.cover instanceof Blob, 'cover is a Blob');
  assert.equal(meta.cover.type, 'image/png');
  assert.ok(meta.cover.size > 0);
});

test('mp3: a nameless blob still yields duration and cover when the path is passed', async () => {
  const file = await fixtureFile('sample.mp3');
  const blob = new Blob([await file.arrayBuffer()], { type: 'application/octet-stream' });
  assert.equal(blob.name, undefined);
  const meta = await readMetadata(blob, "90's/Aimer - StarRingChild.mp3");
  assert.equal(meta.title, 'Night Drive');
  assert.ok(meta.duration > 0);
  assert.ok(meta.cover instanceof Blob);
});

test('m4a: mvhd duration and ilst tags, cover type 14', async () => {
  const meta = await readMetadata(await fixtureFile('sample.m4a'));
  assert.equal(meta.title, 'Fixture Song');
  assert.equal(meta.artist, 'Fixture Artist');
  assert.equal(meta.album, 'Fixture Album');
  assert.equal(meta.year, 2019);
  assert.equal(meta.trackNo, 7);
  assert.ok(Math.abs(meta.duration - 31.234) <= 0.001);
  assert.ok(meta.cover instanceof Blob, 'cover is a Blob');
  assert.equal(meta.cover.type, 'image/png');
  assert.ok(meta.cover.size > 0);
});

test('unsupported extension returns an empty object', async () => {
  const file = new File([new Uint8Array([1, 2, 3, 4])], 'song.flac');
  assert.deepEqual(await readMetadata(file), {});
});

test('malformed or truncated files never throw', async () => {
  const empty = new File([], 'broken.mp3');
  assert.deepEqual(await readMetadata(empty), {});

  const truncated = new File([new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00])], 'broken.mp3');
  assert.deepEqual(await readMetadata(truncated), {});

  const junkM4a = new File([new Uint8Array(64)], 'broken.m4a');
  assert.deepEqual(await readMetadata(junkM4a), {});
});

test('parseId3 works without a tag and estimates CBR duration from the first frame', () => {
  const frame = new Uint8Array(417);
  frame.set([0xff, 0xfb, 0x90, 0x00]);
  const bytes = new Uint8Array(417 * 20);
  for (let i = 0; i < 20; i += 1) bytes.set(frame, i * 417);
  const meta = parseId3(bytes, { fileSize: bytes.length });
  assert.ok(meta.duration > 0);
  assert.ok(Math.abs(meta.duration - (20 * 1152) / 44100) < 0.2);
  assert.equal(meta.title, undefined);
});

test('parseMp4 tolerates a moov that appears after mdat', async () => {
  const bytes = new Uint8Array(await (await fixtureFile('sample.m4a')).arrayBuffer());
  // Reorder top-level atoms: ftyp, mdat, moov.
  const atoms = [];
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const size = uint32(bytes, offset);
    if (size < 8) break;
    atoms.push(bytes.slice(offset, offset + size));
    offset += size;
  }
  const reordered = new Uint8Array(atoms[0].length + atoms[2].length + atoms[1].length);
  reordered.set(atoms[0], 0);
  reordered.set(atoms[2], atoms[0].length);
  reordered.set(atoms[1], atoms[0].length + atoms[2].length);
  const meta = parseMp4(reordered);
  assert.equal(meta.title, 'Fixture Song');
  assert.ok(Math.abs(meta.duration - 31.234) <= 0.001);
});

function uint32(bytes, offset) {
  return (
    ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
  );
}

function legacyBytes(hex) {
  return new Uint8Array(hex.match(/../g).map((byte) => Number.parseInt(byte, 16)));
}

test('decodeLegacyText keeps ASCII bytes and falls back to latin1', () => {
  assert.equal(decodeLegacyText(new TextEncoder().encode('Plain Title')), 'Plain Title');
  assert.equal(decodeLegacyText(legacyBytes('e9')), 'é');
  assert.equal(decodeLegacyText(new Uint8Array(0)), '');
});

test('decodeLegacyText decodes GBK, Shift_JIS and Big5 payloads', () => {
  assert.equal(decodeLegacyText(legacyBytes('d6dcbddcc2d7')), '周杰伦');
  assert.equal(decodeLegacyText(legacyBytes('95c492c38cba8e74')), '米津玄師');
  assert.equal(decodeLegacyText(legacyBytes('a4ada4eba4d1')), '五月天');
  assert.equal(decodeLegacyText(new TextEncoder().encode('周杰伦')), '周杰伦');
});

test('mp3: encoding-0 GBK frames from Chinese sources', async () => {
  const meta = await readMetadata(await fixtureFile('cjk-gbk-v2.mp3'));
  assert.equal(meta.title, '周杰伦');
  assert.equal(meta.artist, '七里香');
  assert.equal(meta.album, '叶惠美');
});

test('mp3: encoding-0 Shift_JIS frames from Japanese sources', async () => {
  const meta = await readMetadata(await fixtureFile('cjk-sjis-v2.mp3'));
  assert.equal(meta.title, '米津玄師');
  assert.equal(meta.artist, 'Lemon');
  assert.equal(meta.album, 'STRAY SHEEP');
});

test('mp3: encoding-0 Big5 frames from Taiwanese sources', async () => {
  const meta = await readMetadata(await fixtureFile('cjk-big5-v2.mp3'));
  assert.equal(meta.title, '五月天');
  assert.equal(meta.artist, '突然好想你');
  assert.equal(meta.album, '後青春期的詩');
});

test('mp3: ID3v1-only file falls back to the ID3v1 tag', async () => {
  const meta = await readMetadata(await fixtureFile('cjk-gbk-v1.mp3'));
  assert.equal(meta.title, '周杰伦');
  assert.equal(meta.artist, '七里香');
  assert.equal(meta.album, '叶惠美');
  assert.equal(meta.year, 2004);
});

test('mp3: encoding-0 UTF-8 frames and plain ASCII frames', async () => {
  const utf8 = await readMetadata(await fixtureFile('cjk-utf8-v2.mp3'));
  assert.equal(utf8.title, '周杰伦');
  assert.equal(utf8.artist, '七里香');

  const ascii = await readMetadata(await fixtureFile('ascii-v2.mp3'));
  assert.equal(ascii.title, 'Plain Title');
  assert.equal(ascii.artist, 'Plain Artist');
  assert.equal(ascii.album, 'Plain Album');
});

test('mp3: ID3v1-only file still probes a positive duration', async () => {
  const meta = await readMetadata(await fixtureFile('cjk-gbk-v1.mp3'));
  assert.ok(meta.duration > 0, `duration ${meta.duration}`);
});
