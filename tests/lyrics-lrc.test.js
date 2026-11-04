import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLrc,
  activeLineIndex,
  decodeLyricsBytes,
  sidecarCandidates,
} from '../src/core/lyrics/lrc.js';

const near = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, message ?? `${actual} != ${expected}`);

test('lrc: basic [m:ss] and [mm:ss] tags', () => {
  const { lines } = parseLrc('[00:05]intro\n[01:02]verse');
  assert.deepEqual(lines.map((line) => line.text), ['intro', 'verse']);
  near(lines[0].time, 5);
  near(lines[1].time, 62);
});

test('lrc: one, two and three digit milliseconds', () => {
  const { lines } = parseLrc('[00:01.5]a\n[00:02.25]b\n[00:03.125]c');
  near(lines[0].time, 1.5);
  near(lines[1].time, 2.25);
  near(lines[2].time, 3.125);
});

test('lrc: [mm:ss] minutes may exceed 59', () => {
  const { lines } = parseLrc('[75:30]long');
  near(lines[0].time, 75 * 60 + 30);
});

test('lrc: [h:mm:ss.xx] hour tags', () => {
  const { lines } = parseLrc('[1:02:03.45]chorus');
  near(lines[0].time, 3723.45);
});

test('lrc: multiple time tags on one line duplicate the text', () => {
  const { lines } = parseLrc('[00:10][00:20.50][01:30]same');
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((line) => line.text), ['same', 'same', 'same']);
  near(lines[0].time, 10);
  near(lines[1].time, 20.5);
  near(lines[2].time, 90);
});

test('lrc: out-of-order lines are sorted by time', () => {
  const { lines } = parseLrc('[00:30]third\n[00:10]first\n[00:20]second');
  assert.deepEqual(lines.map((line) => line.text), ['first', 'second', 'third']);
});

test('lrc: equal times keep file order', () => {
  const { lines } = parseLrc('[00:10]one\n[00:10]two\n[00:10]three');
  assert.deepEqual(lines.map((line) => line.text), ['one', 'two', 'three']);
});

test('lrc: positive [offset:] shifts every timed line', () => {
  const { offset, lines } = parseLrc('[offset:+500]\n[00:10.00]a\n[00:20.00]b');
  assert.equal(offset, 500);
  near(lines[0].time, 10.5);
  near(lines[1].time, 20.5);
});

test('lrc: negative offset clamps times to zero', () => {
  const { lines } = parseLrc('[offset:-2000]\n[00:01.00]a\n[00:05.00]b');
  assert.equal(lines[0].time, 0);
  near(lines[1].time, 3);
});

test('lrc: enhanced word tags are stripped', () => {
  const { lines } = parseLrc('[00:10.00]<00:10.00>Hello <00:10.50>world<00:11.00>');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'Hello world');
});

test('lrc: timed lines with empty text are skipped', () => {
  const { lines, plain } = parseLrc('[00:01]   \n[00:02]real\n[00:03]<00:03.00>');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'real');
  assert.equal(plain, '');
});

test('lrc: text without time tags becomes plain', () => {
  const { lines, plain } = parseLrc('[ti:Title]\nfirst line\n\nsecond line\n');
  assert.deepEqual(lines, []);
  assert.equal(plain, 'first line\nsecond line');
});

test('lrc: mixed timed and untimed text leaves plain empty', () => {
  const { lines, plain } = parseLrc('untimed note\n[00:01]timed');
  assert.equal(lines.length, 1);
  assert.equal(plain, '');
});

test('lrc: metadata tags never produce lyric lines', () => {
  const text = [
    '[ar:Artist]',
    '[ti:Title]',
    '[al:Album]',
    '[by:Someone]',
    '[offset:0]',
    '[length:03:24]',
    '[re:Tool 1.0]',
    '[ve:1.0]',
    '[tool:Editor]',
  ].join('\n');
  const { lines, plain } = parseLrc(text);
  assert.deepEqual(lines, []);
  assert.equal(plain, '');
});

test('lrc: metadata-only input returns empty lines and plain', () => {
  const { lines, plain } = parseLrc('[ti:x]');
  assert.deepEqual(lines, []);
  assert.equal(plain, '');
});

test('lrc: CRLF and lone CR line endings', () => {
  const { lines } = parseLrc('[00:01]a\r\n[00:02]b\r[00:03]c');
  assert.deepEqual(lines.map((line) => line.text), ['a', 'b', 'c']);
});

test('lrc: UTF-8 BOM is removed before parsing', () => {
  const { lines } = parseLrc('\ufeff[00:01]first');
  assert.equal(lines[0].text, 'first');
});

test('lrc: trimmed text keeps inner spacing', () => {
  const { lines } = parseLrc('[00:01]  hello   world  ');
  assert.equal(lines[0].text, 'hello   world');
});

test('activeLineIndex: empty and before-first positions return -1', () => {
  assert.equal(activeLineIndex([], 5), -1);
  const lines = [{ time: 10, text: 'a' }, { time: 20, text: 'b' }];
  assert.equal(activeLineIndex(lines, 9.99), -1);
  assert.equal(activeLineIndex(lines, Number.NaN), -1);
});

test('activeLineIndex: exact and between timestamps', () => {
  const lines = [{ time: 10, text: 'a' }, { time: 20, text: 'b' }, { time: 30, text: 'c' }];
  assert.equal(activeLineIndex(lines, 10), 0);
  assert.equal(activeLineIndex(lines, 25), 1);
  assert.equal(activeLineIndex(lines, 30), 2);
  assert.equal(activeLineIndex(lines, 300), 2);
});

test('decodeLyricsBytes: UTF-8 with BOM and legacy GBK fallback', () => {
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]);
  assert.equal(decodeLyricsBytes(bom), 'hi');
  // GBK for 你好: invalid UTF-8, so the legacy code-page heuristic takes over.
  const gbk = new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]);
  assert.equal(decodeLyricsBytes(gbk), '你好');
  assert.equal(decodeLyricsBytes(null), '');
});

test('sidecarCandidates: replaces the last extension with .lrc and .LRC', () => {
  assert.deepEqual(sidecarCandidates('Music/Album/song.mp3'), [
    'Music/Album/song.lrc',
    'Music/Album/song.LRC',
  ]);
  assert.deepEqual(sidecarCandidates('song'), ['song.lrc', 'song.LRC']);
  assert.deepEqual(sidecarCandidates('.mp3'), []);
  assert.deepEqual(sidecarCandidates(''), []);
});
