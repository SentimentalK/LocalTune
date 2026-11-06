import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeQuery,
  searchGroup,
  searchTracks,
  runSearch,
} from '../src/core/search.js';
import { ensureNormalizer } from '../src/core/text.js';

// The hanzi table is a lazy chunk; load it once so the synchronous
// `searchTracks` cases below see traditional characters.
await ensureNormalizer();

function track(id, extra = {}) {
  return { id, title: '', artist: '', album: '', path: '', ...extra };
}

function pairs(result) {
  return result.items.map((item) => [item.track.id, item.group]);
}

// --- runSearch -----------------------------------------------------------

test('runSearch matches a simplified query against traditional artist names', async () => {
  const library = [
    track('tw-1', { title: '晴天', artist: '週杰倫', album: '葉惠美', path: 'Music/qing.mp3' }),
    track('tw-2', { title: '夜曲', artist: '週杰倫', album: '十一月的蕭邦', path: 'Music/ye.mp3' }),
  ];

  const result = await runSearch(library, '周');

  assert.deepEqual(pairs(result), [
    ['tw-1', 'artist'],
    ['tw-2', 'artist'],
  ]);
  assert.equal(result.total, 2);
});

test('simplified query hits a traditional title', async () => {
  const library = [track('trad-title', { title: '給我一個理由忘記', artist: 'A-Lin' })];

  const result = await runSearch(library, '给我');

  assert.deepEqual(pairs(result), [['trad-title', 'title']]);
  assert.equal(result.counts.title, 1);
});

// --- field folding -------------------------------------------------------

test('full-width query matches half-width title text', () => {
  const result = searchTracks([track('full', { title: 'ABC123', artist: 'Zed' })], 'ＡＢＣ１２３');

  assert.deepEqual(pairs(result), [['full', 'title']]);
  assert.equal(result.total, 1);
});

test('query matching is case insensitive', () => {
  const result = searchTracks([track('case', { title: 'Hello World', artist: 'Adele' })], 'HELLO');

  assert.deepEqual(pairs(result), [['case', 'title']]);
});

test('empty title falls back to the file name', () => {
  const library = [track('file', { path: 'Music/夜曲.mp3' })];

  const result = searchTracks(library, '夜曲');

  assert.deepEqual(pairs(result), [['file', 'fileName']]);
  assert.equal(result.counts.fileName, 1);
});

// --- grouping and ordering ----------------------------------------------

test('title wins over artist when both match the same track', () => {
  const library = [track('both', { title: 'Love Story', artist: 'Love Band' })];

  const result = searchTracks(library, 'love');

  assert.deepEqual(pairs(result), [['both', 'title']]);
  assert.equal(result.counts.artist, 0);
});

test('results follow group priority before input order', () => {
  const library = [
    track('artist-hit', { title: 'Other', artist: 'Love Band' }),
    track('title-hit', { title: 'Love Song' }),
  ];

  const result = searchTracks(library, 'love');

  assert.deepEqual(pairs(result), [
    ['title-hit', 'title'],
    ['artist-hit', 'artist'],
  ]);
  assert.equal(result.total, 2);
});

test('featured artists are searchable', () => {
  const library = [track('feat', { title: 'Untitled', artist: 'A feat. B' })];

  const result = searchTracks(library, 'b');

  assert.deepEqual(pairs(result), [['feat', 'artist']]);
});

// --- empty query and limit ----------------------------------------------

test('empty and whitespace-only queries return nothing', async () => {
  const library = [track('any', { title: 'Song', artist: 'Singer' })];

  const empty = searchTracks(library, '');
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.items, []);

  const blank = await runSearch(library, '   ');
  assert.equal(blank.total, 0);
  assert.deepEqual(blank.counts, { title: 0, artist: 0, album: 0, fileName: 0 });
});

test('limit truncates items but not total or counts', () => {
  const library = Array.from({ length: 5 }, (_, index) => track(`m-${index}`, { title: `Song ${index}` }));

  const result = searchTracks(library, 'song', { limit: 2 });

  assert.deepEqual(result.items.map((item) => item.track.id), ['m-0', 'm-1']);
  assert.equal(result.total, 5);
  assert.equal(result.counts.title, 5);
});

// --- normalizeQuery / searchGroup ---------------------------------------

test('normalizeQuery folds script, width and case, and rejects non-strings', () => {
  assert.equal(normalizeQuery(' 週 '), '周');
  assert.equal(normalizeQuery('ＡＢＣ'), 'abc');
  assert.equal(normalizeQuery(null), '');
});

test('searchGroup normalizes its query too', () => {
  assert.equal(searchGroup(track('s', { title: '夜曲' }), '夜曲'), 'title');
  assert.equal(searchGroup(track('s', { title: '夜曲' }), '晴天'), null);
});
