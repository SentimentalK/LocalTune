import { test } from 'node:test';
import assert from 'node:assert/strict';

import { migrateGarbledTracks, selectRereadTargets } from '../src/core/migrate.js';

const MOJIBAKE = 'Ã¤Â¸Â­';

function makeTrack(id, overrides = {}) {
  return {
    id,
    path: `${id}.mp3`,
    title: MOJIBAKE,
    artist: MOJIBAKE,
    album: '',
    year: null,
    trackNo: null,
    duration: 0,
    mtime: 1_700_000_000_000,
    size: 4096,
    cover: null,
    source: 'fsa',
    externalIds: {},
    ...overrides,
  };
}

test('migrateGarbledTracks re-reads only suspicious tracks and isolates failures', async () => {
  const tracks = [
    makeTrack('garbled'),
    makeTrack('clean', { title: '正常标题', artist: '正常歌手', album: '正常专辑' }),
    makeTrack('broken'),
  ];
  const requests = [];
  const getFile = async (path) => {
    requests.push(path);
    if (path === 'broken.mp3') throw new Error('missing file');
    return { path };
  };
  const readPaths = [];
  let readCount = 0;
  const readMetadata = async (file) => {
    readCount += 1;
    readPaths.push(file.path);
    return {
      title: '中文标题',
      artist: '中文歌手',
      album: '中文专辑',
      year: 2001,
      trackNo: 3,
      duration: 180,
      cover: { type: 'image/png' },
    };
  };
  const progress = [];

  const result = await migrateGarbledTracks({
    tracks,
    getFile,
    readMetadata,
    onProgress: (step) => progress.push(step),
  });

  assert.equal(readCount, 1);
  assert.deepEqual(readPaths, ['garbled.mp3']);
  assert.deepEqual(requests, ['garbled.mp3', 'broken.mp3']);
  assert.equal(result.checked, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.changed.length, 1);

  const [updated] = result.changed;
  assert.equal(updated.id, 'garbled');
  assert.equal(updated.title, '中文标题');
  assert.equal(updated.artist, '中文歌手');
  assert.equal(updated.album, '中文专辑');
  assert.equal(updated.year, 2001);
  assert.equal(updated.trackNo, 3);
  assert.equal(updated.duration, 180);
  assert.deepEqual(updated.cover, { type: 'image/png' });
  // Identity and scan bookkeeping are preserved.
  assert.equal(updated.path, 'garbled.mp3');
  assert.equal(updated.mtime, 1_700_000_000_000);
  assert.equal(updated.size, 4096);
  assert.equal(updated.source, 'fsa');
  assert.deepEqual(updated.externalIds, {});

  assert.deepEqual(
    progress.map((step) => ({ done: step.done, total: step.total, failed: step.failed })),
    [
      { done: 1, total: 2, failed: 0 },
      { done: 2, total: 2, failed: 1 },
    ],
  );
});

test('migrateGarbledTracks keeps old values when the new ones are empty or invalid', async () => {
  const track = makeTrack('partial', {
    artist: '旧歌手',
    album: '旧专辑',
    year: 1999,
    trackNo: 2,
    duration: 100,
    cover: { type: 'image/jpeg' },
  });

  const result = await migrateGarbledTracks({
    tracks: [track],
    getFile: async () => ({}),
    readMetadata: async () => ({
      title: '',
      artist: '新歌手',
      album: '',
      year: Number.NaN,
      trackNo: null,
      duration: 0,
      cover: null,
    }),
  });

  assert.equal(result.changed.length, 1);
  const [updated] = result.changed;
  assert.equal(updated.title, MOJIBAKE);
  assert.equal(updated.artist, '新歌手');
  assert.equal(updated.album, '旧专辑');
  assert.equal(updated.year, 1999);
  assert.equal(updated.trackNo, 2);
  assert.equal(updated.duration, 100);
  assert.deepEqual(updated.cover, { type: 'image/jpeg' });
});

test('migrateGarbledTracks leaves thoroughly unchanged tracks out of changed', async () => {
  const track = makeTrack('same');
  const result = await migrateGarbledTracks({
    tracks: [track],
    getFile: async () => ({}),
    readMetadata: async () => ({ title: MOJIBAKE, artist: MOJIBAKE, album: '' }),
  });

  assert.equal(result.checked, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(result.changed, []);
});

const SWAPPED = [
  '䠀椀琀漀洀椀 吀愀欀愀栀愀猀栀椀',
  '匀琀愀爀刀椀渀最䌀栀椀氀搀',
  '댰댰渰愰娰',
];

test('selectRereadTargets re-reads every track when the parser version moved', () => {
  const tracks = [
    makeTrack('garbled'),
    makeTrack('clean-a', { title: '正常标题', artist: '正常歌手', album: '正常专辑' }),
    makeTrack('clean-b', { title: 'Hello', artist: '', album: '' }),
  ];

  const ids = selectRereadTargets(tracks, {
    kind: 'fsa',
    parserVersion: 2,
    lastParserVersion: 1,
  }).map((track) => track.id);

  assert.deepEqual(ids, ['garbled', 'clean-a', 'clean-b']);
});

test('selectRereadTargets keeps OneDrive on the heuristic, and local too at the same version', () => {
  const swapped = SWAPPED.map((text, index) =>
    makeTrack(`swapped-${index}`, { title: text, artist: text, album: text }),
  );
  const clean = [
    makeTrack('ko', { title: '사랑', artist: '', album: '' }),
    makeTrack('zh', { title: '夜空中最亮的星', artist: '', album: '' }),
    makeTrack('ja', { title: '春はゆく', artist: '', album: '' }),
  ];
  const tracks = [...swapped, ...clean];
  const expected = ['swapped-0', 'swapped-1', 'swapped-2'];

  assert.deepEqual(
    selectRereadTargets(tracks, {
      kind: 'onedrive',
      parserVersion: 2,
      lastParserVersion: 1,
    }).map((track) => track.id),
    expected,
  );
  assert.deepEqual(
    selectRereadTargets(tracks, {
      kind: 'fsa',
      parserVersion: 2,
      lastParserVersion: 2,
    }).map((track) => track.id),
    expected,
  );
});

test('migrateGarbledTracks re-reads all 60 tracks through shouldRead', async () => {
  const tracks = Array.from({ length: 60 }, (_, index) =>
    makeTrack(`track-${index}`, { title: '正常标题', artist: '正常歌手', album: '' }),
  );
  const progress = [];
  const started = Date.now();

  const result = await migrateGarbledTracks({
    tracks,
    shouldRead: () => true,
    getFile: async (path) => ({ path }),
    readMetadata: async (file) => ({ title: `Re-read ${file.path}` }),
    onProgress: (step) => progress.push(step),
  });
  const elapsed = Date.now() - started;

  assert.equal(result.checked, 60);
  assert.equal(result.failed, 0);
  assert.equal(result.changed.length, 60);
  assert.equal(progress.at(-1).done, 60);
  assert.equal(progress.at(-1).total, 60);
  assert.ok(elapsed < 10_000, `elapsed ${elapsed}ms`);
});
