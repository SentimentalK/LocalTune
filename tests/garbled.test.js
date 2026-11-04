import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isGarbledText, isGarbledTrack } from '../src/core/metadata/garbled.js';

test('isGarbledText flags replacement characters', () => {
  assert.equal(isGarbledText('\uFFFD'), true);
  assert.equal(isGarbledText('中文\uFFFD标题'), true);
});

test('isGarbledText flags text whose non-ASCII chars all fit Latin-1', () => {
  assert.equal(isGarbledText('Ã¤Â¸Â­'), true);
  assert.equal(isGarbledText('Song Ã¤Â¸Â­'), true);
});

test('isGarbledText flags text that is exactly half half-width katakana', () => {
  const kana = '\uFF71'.repeat(50); // half-width katakana A
  const cjk = '中'.repeat(50);
  assert.equal(isGarbledText(kana + cjk), true);
});

test('isGarbledText accepts text just under half half-width katakana', () => {
  const kana = '\uFF71'.repeat(49);
  const cjk = '中'.repeat(51);
  assert.equal(isGarbledText(kana + cjk), false);
});

test('isGarbledText leaves normal Chinese and Japanese alone', () => {
  assert.equal(isGarbledText('中文标题'), false);
  assert.equal(isGarbledText('こんにちは世界'), false);
  assert.equal(isGarbledText('アイウエオ漢字'), false);
  assert.equal(isGarbledText('카페'), false);
});

test('isGarbledText ignores ASCII, empty and non-string values', () => {
  assert.equal(isGarbledText('Hello World 123'), false);
  assert.equal(isGarbledText(''), false);
  assert.equal(isGarbledText(null), false);
  assert.equal(isGarbledText(42), false);
});

test('isGarbledTrack flags any of title, artist or album', () => {
  const clean = { title: '正常标题', artist: '歌手', album: '专辑' };
  assert.equal(isGarbledTrack(clean), false);
  for (const key of ['title', 'artist', 'album']) {
    assert.equal(isGarbledTrack({ ...clean, [key]: 'Ã¤Â¸Â­' }), true, key);
  }
});
