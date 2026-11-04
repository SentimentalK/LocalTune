import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLyrics } from '../src/core/lyrics/index.js';

function fileOf(text, name) {
  return new File([new TextEncoder().encode(text)], name);
}

function getFileFrom(map) {
  return async (path) => {
    if (!(path in map)) throw new Error(`missing ${path}`);
    const value = map[path];
    return typeof value === 'function' ? value() : value;
  };
}

test('resolve: FSA-style sidecar hit returns parsed LRC lines', async () => {
  const track = { path: 'Library/Artist/song.mp3' };
  const result = await resolveLyrics({
    track,
    getFile: getFileFrom({
      'Library/Artist/song.lrc': fileOf('[ar:Artist]\n[00:10.50]hello\n[00:20]world', 'song.lrc'),
    }),
  });
  assert.equal(result.source, 'lrc');
  assert.deepEqual(result.lines, [
    { time: 10.5, text: 'hello' },
    { time: 20, text: 'world' },
  ]);
  assert.equal(result.plain, '');
});

test('resolve: timeless sidecar returns lrc-plain with empty lines', async () => {
  const result = await resolveLyrics({
    track: { path: 'song.mp3' },
    getFile: getFileFrom({ 'song.lrc': fileOf('just words\nand more', 'song.lrc') }),
  });
  assert.deepEqual(result, { source: 'lrc-plain', lines: [], plain: 'just words\nand more' });
});

test('resolve: Uint8Array sidecars are accepted, not only Blob/File', async () => {
  const result = await resolveLyrics({
    track: { path: 'a/b.mp3' },
    getFile: getFileFrom({ 'a/b.lrc': new TextEncoder().encode('[00:01]bytes') }),
  });
  assert.equal(result.source, 'lrc');
  assert.equal(result.lines[0].text, 'bytes');
});

test('resolve: OneDrive-style missing sidecars fall back to embedded USLT', async () => {
  const result = await resolveLyrics({
    track: { path: 'remote/song.mp3' },
    getFile: getFileFrom({ 'remote/song.mp3': fileOf('audio', 'song.mp3') }),
    readEmbedded: async (file) => {
      assert.equal(file.name, 'song.mp3');
      return { synced: [], plain: 'embedded words' };
    },
  });
  assert.deepEqual(result, { source: 'uslt', lines: [], plain: 'embedded words' });
});

test('resolve: m4a embedded lyrics use the lyr source', async () => {
  const result = await resolveLyrics({
    track: { path: 'remote/song.m4a' },
    getFile: getFileFrom({ 'remote/song.m4a': fileOf('audio', 'song.m4a') }),
    readEmbedded: async () => ({ synced: [], plain: 'm4a words' }),
  });
  assert.equal(result.source, 'lyr');
  assert.equal(result.plain, 'm4a words');
});

test('resolve: embedded SYLT wins and its lines are returned', async () => {
  const result = await resolveLyrics({
    track: { path: 'song.mp3' },
    getFile: getFileFrom({ 'song.mp3': fileOf('audio', 'song.mp3') }),
    readEmbedded: async () => ({ synced: [{ time: 3, text: 'sync' }], plain: 'ignored' }),
  });
  assert.deepEqual(result, { source: 'sylt', lines: [{ time: 3, text: 'sync' }], plain: '' });
});

test('resolve: every getFile failure returns none', async () => {
  const result = await resolveLyrics({
    track: { path: 'gone/song.mp3' },
    getFile: async () => {
      throw new Error('denied');
    },
  });
  assert.deepEqual(result, { source: 'none', lines: [], plain: '' });
});

test('resolve: unreadable sidecars and no embedded tag return none', async () => {
  const result = await resolveLyrics({
    track: { path: 'song.mp3' },
    getFile: getFileFrom({
      'song.lrc': () => {
        throw new Error('unreadable');
      },
      'song.LRC': new Uint8Array(0),
      'song.mp3': fileOf('audio', 'song.mp3'),
    }),
    readEmbedded: async () => ({ synced: [], plain: '' }),
  });
  assert.equal(result.source, 'none');
});

test('resolve: embedded parser throwing is swallowed', async () => {
  const result = await resolveLyrics({
    track: { path: 'song.mp3' },
    getFile: getFileFrom({ 'song.mp3': fileOf('audio', 'song.mp3') }),
    readEmbedded: async () => {
      throw new Error('bad tag');
    },
  });
  assert.equal(result.source, 'none');
});

test('resolve: missing track path short-circuits to none', async () => {
  let calls = 0;
  const result = await resolveLyrics({
    track: {},
    getFile: async () => {
      calls += 1;
      return new Uint8Array(0);
    },
  });
  assert.equal(result.source, 'none');
  assert.equal(calls, 0);
});
