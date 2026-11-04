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

test('isGarbledText flags text whose UTF-16 bytes were swapped', () => {
  assert.equal(isGarbledText('䠀椀琀漀洀椀 吀愀欀愀栀愀猀栀椀'), true);
  assert.equal(isGarbledText('匀琀愀爀刀椀渀最䌀栀椀氀搀'), true);
  assert.equal(isGarbledText('댰댰渰愰娰'), true);
});

test('isGarbledText leaves normal CJK alone even with swapped-looking units', () => {
  assert.equal(isGarbledText('사랑'), false);
  assert.equal(isGarbledText('夜空中最亮的星'), false);
  assert.equal(isGarbledText('春はゆく'), false);
  assert.equal(isGarbledText('ココロのちず'), false);
  assert.equal(isGarbledText('奈落の花'), false);
});

test('isGarbledTrack flags swapped-byte titles', () => {
  for (const title of ['䠀椀琀漀洀椀 吀愀欀愀栀愀猀栀椀', '匀琀愀爀刀椀渀最䌀栀椀氀搀', '댰댰渰愰娰']) {
    assert.equal(isGarbledTrack({ title, artist: '', album: '' }), true, title);
  }
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
