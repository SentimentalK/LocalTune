import { test } from 'node:test';
import assert from 'node:assert/strict';

import { t } from '../src/i18n/index.js';
import {
  PLAYLIST_SOURCES,
  m3u8Text,
  missingText,
  normalizePlaylist,
  normalizePlaylistItem,
  playlistCounts,
  rematchPlaylist,
  sanitizeFileName,
} from '../src/core/playlist/model.js';

const TRACKS = [
  {
    id: 'fsa:Music/Eason.mp3',
    path: 'Music/Eason Chan - 十年.mp3',
    title: '十年',
    artist: 'Eason Chan',
    duration: 225,
  },
  {
    id: 'fsa:Music/Untitled.mp3',
    path: 'Music/Untitled Track.mp3',
    title: 'Untitled Track',
    artist: '',
    duration: 0,
  },
];

function item(patch = {}) {
  return {
    title: 'Title',
    artist: 'Artist',
    durationMs: null,
    matchedTrackId: null,
    status: 'missing',
    reasons: [],
    coverUrl: null,
    ...patch,
  };
}

function playlistOf(items) {
  return { id: 'pl_1_abcdef', name: 'Mix', source: 'text', sourceUrl: null, items, createdAt: 1 };
}

test('normalizePlaylistItem fills every default', () => {
  assert.deepEqual(normalizePlaylistItem({}), {
    title: '',
    artist: '',
    durationMs: null,
    matchedTrackId: null,
    status: 'missing',
    reasons: [],
    coverUrl: null,
  });
  assert.deepEqual(normalizePlaylistItem(null), normalizePlaylistItem({}));
});

test('normalizePlaylistItem demotes a non-missing status without a track id', () => {
  assert.equal(normalizePlaylistItem(item({ status: 'matched' })).status, 'missing');
  assert.equal(normalizePlaylistItem(item({ status: 'suspect' })).status, 'missing');
  assert.equal(
    normalizePlaylistItem(item({ status: 'suspect', matchedTrackId: 'fsa:a.mp3' })).status,
    'suspect',
  );
});

test('normalizePlaylistItem falls back to missing and keeps known reasons only', () => {
  const unknown = normalizePlaylistItem(item({ status: 'wired', reasons: ['artist'] }));
  assert.equal(unknown.status, 'missing');
  assert.deepEqual(unknown.reasons, ['artist']);

  const cleaned = normalizePlaylistItem(
    item({ status: 'suspect', matchedTrackId: 'fsa:a.mp3', reasons: ['artist', 'tempo', 'duration'] }),
  );
  assert.deepEqual(cleaned.reasons, ['artist', 'duration']);
});

test('normalizePlaylist names an empty name with the untitled string', () => {
  assert.equal(normalizePlaylist({ name: '   ' }).name, t('playlists.untitled'));
  assert.equal(normalizePlaylist({}).name, t('playlists.untitled'));
  assert.equal(normalizePlaylist({ name: '  Road trip  ' }).name, 'Road trip');
});

test('normalizePlaylist keeps a known source and falls back to text', () => {
  for (const source of PLAYLIST_SOURCES) {
    assert.equal(normalizePlaylist({ source }).source, source);
  }
  assert.equal(normalizePlaylist({ source: 'deezer' }).source, 'text');
  assert.equal(normalizePlaylist({}).source, 'text');
});

test('normalizePlaylist keeps only http(s) source urls', () => {
  assert.equal(
    normalizePlaylist({ sourceUrl: ' https://youtu.be/abc ' }).sourceUrl,
    'https://youtu.be/abc',
  );
  assert.equal(normalizePlaylist({ sourceUrl: 'http://example.com/p' }).sourceUrl, 'http://example.com/p');
  assert.equal(normalizePlaylist({ sourceUrl: 'ftp://example.com/p' }).sourceUrl, null);
  assert.equal(normalizePlaylist({ sourceUrl: 'javascript:alert(1)' }).sourceUrl, null);
  assert.equal(normalizePlaylist({ sourceUrl: 42 }).sourceUrl, null);
  assert.equal(normalizePlaylist({}).sourceUrl, null);
});

test('normalizePlaylist generates pl_ ids and keeps a supplied one', () => {
  const now = () => 1700000000000;
  const generated = normalizePlaylist({ name: 'P' }, { now });
  assert.match(generated.id, /^pl_\d+_[0-9a-f]{6}$/);
  assert.ok(generated.id.startsWith('pl_1700000000000_'));
  assert.equal(generated.createdAt, 1700000000000);

  assert.equal(normalizePlaylist({ name: 'P' }, { id: 'pl_custom' }).id, 'pl_custom');
  assert.equal(normalizePlaylist({ name: 'P', createdAt: 7 }, { now }).createdAt, 7);
});

test('normalizePlaylist normalizes items and tolerates a missing list', () => {
  const playlist = normalizePlaylist({
    name: 'P',
    items: [{ title: 'A' }, null, { title: 'B', status: 'matched' }],
  });
  assert.deepEqual(
    playlist.items.map((row) => row.status),
    ['missing', 'missing', 'missing'],
  );
  assert.deepEqual(playlist.items[0], normalizePlaylistItem({ title: 'A' }));
  assert.deepEqual(normalizePlaylist(null).items, []);
  assert.deepEqual(normalizePlaylist({ items: 'nope' }).items, []);
});

test('playlistCounts counts the three states', () => {
  const counts = playlistCounts(
    playlistOf([
      item({ status: 'matched', matchedTrackId: 'a' }),
      item({ status: 'suspect', matchedTrackId: 'b', reasons: ['duration'] }),
      item({ status: 'missing' }),
      item({ status: 'missing' }),
    ]),
  );
  assert.deepEqual(counts, { matched: 1, suspect: 1, missing: 2 });
  assert.deepEqual(playlistCounts(playlistOf([])), { matched: 0, suspect: 0, missing: 0 });
});

test('missingText writes artist - title per row, in order, with a trailing newline', () => {
  const text = missingText(
    playlistOf([
      item({ title: 'First', artist: 'A' }),
      item({ title: 'Second', artist: '' }),
      item({ title: 'Third', artist: 'C' }),
    ]),
  );
  assert.equal(text, 'A - First\nSecond\nC - Third\n');
});

test('missingText ignores suspect rows and returns an empty string when nothing is missing', () => {
  const text = missingText(
    playlistOf([
      item({ title: 'Missing', artist: 'A' }),
      item({ title: 'Suspect', artist: 'B', status: 'suspect', matchedTrackId: 'x' }),
      item({ title: 'Matched', artist: 'C', status: 'matched', matchedTrackId: 'y' }),
    ]),
  );
  assert.equal(text, 'A - Missing\n');

  assert.equal(missingText(playlistOf([])), '');
  assert.equal(
    missingText(playlistOf([item({ status: 'suspect', matchedTrackId: 'x' })])),
    '',
  );
});

test('sanitizeFileName removes reserved and control characters', () => {
  assert.equal(sanitizeFileName('A/B\\C:D*E?F"G<H>I|J'), 'ABCDEFGHIJ');
  assert.equal(sanitizeFileName('a\u0000b\u001fc\u007fd'), 'abcd');
  assert.equal(sanitizeFileName('  road   trip  '), 'road trip');
});

test('sanitizeFileName falls back to playlist and truncates to 80 characters', () => {
  assert.equal(sanitizeFileName(''), 'playlist');
  assert.equal(sanitizeFileName('///'), 'playlist');
  assert.equal(sanitizeFileName(null), 'playlist');

  const long = sanitizeFileName('x'.repeat(120));
  assert.equal(long.length, 80);
  assert.equal(sanitizeFileName('歌'.repeat(100)).length, 80);
});

test('m3u8Text writes matched rows only, in playlist order', () => {
  const text = m3u8Text(
    playlistOf([
      item({ title: 'Ignored', status: 'missing' }),
      item({
        title: '十年',
        artist: 'Eason Chan',
        status: 'matched',
        matchedTrackId: 'fsa:Music/Eason.mp3',
      }),
      item({
        title: 'Suspect',
        status: 'suspect',
        matchedTrackId: 'fsa:Music/Untitled.mp3',
      }),
      item({
        title: 'Gone',
        status: 'matched',
        matchedTrackId: 'fsa:missing.mp3',
      }),
    ]),
    TRACKS,
  );

  assert.equal(
    text,
    '#EXTM3U\n#EXTINF:225,Eason Chan - 十年\n./Music/Eason Chan - 十年.mp3\n',
  );
});

test('m3u8Text falls back for unknown durations and blank artists', () => {
  const text = m3u8Text(
    playlistOf([
      item({
        title: 'Untitled Track',
        artist: '',
        status: 'matched',
        matchedTrackId: 'fsa:Music/Untitled.mp3',
      }),
    ]),
    TRACKS,
  );
  assert.equal(text, '#EXTM3U\n#EXTINF:-1,Untitled Track\n./Music/Untitled Track.mp3\n');
  assert.ok(text.endsWith('\n'));
  assert.ok(!text.endsWith('\n\n'));

  const withItemArtist = m3u8Text(
    playlistOf([
      item({
        title: 'Untitled Track',
        artist: 'Guest',
        status: 'matched',
        matchedTrackId: 'fsa:Music/Untitled.mp3',
      }),
    ]),
    TRACKS,
  );
  assert.match(withItemArtist, /#EXTINF:-1,Guest - Untitled Track\n/);
});

test('m3u8Text writes only the header for an empty playlist', () => {
  assert.equal(m3u8Text(playlistOf([]), TRACKS), '#EXTM3U\n');
  assert.equal(m3u8Text({ items: [] }, []), '#EXTM3U\n');
  assert.equal(m3u8Text(null, null), '#EXTM3U\n');
});

test('rematchPlaylist fills missing rows and counts the hits', async () => {
  const playlist = playlistOf([
    item({ title: '十年', artist: '陈奕迅' }),
    item({ title: 'Nothing like it', artist: '' }),
  ]);
  const { playlist: next, added } = await rematchPlaylist(playlist, [
    {
      id: 'fsa:Music/ten-years.mp3',
      path: 'Music/ten-years.mp3',
      title: '十年',
      artist: '陈奕迅',
      duration: 225,
    },
  ]);

  assert.equal(added, 1);
  assert.equal(next.items[0].status, 'matched');
  assert.equal(next.items[0].matchedTrackId, 'fsa:Music/ten-years.mp3');
  assert.deepEqual(next.items[0].reasons, []);
  assert.deepEqual(next.items[1], playlist.items[1]);
  assert.equal(next.items[1].status, 'missing');
  assert.equal(next.items[1].matchedTrackId, null);
});

test('rematchPlaylist leaves the input untouched and skips non-missing rows', async () => {
  const suspect = item({
    title: 'Hint',
    artist: 'X',
    status: 'suspect',
    matchedTrackId: 'fsa:Music/Eason.mp3',
    reasons: ['duration'],
  });
  const playlist = playlistOf([suspect]);
  const snapshot = JSON.stringify(playlist);

  const result = await rematchPlaylist(playlist, TRACKS);

  assert.equal(result.added, 0);
  assert.equal(JSON.stringify(playlist), snapshot);
  assert.notEqual(result.playlist, playlist);
  assert.notEqual(result.playlist.items, playlist.items);
  assert.equal(result.playlist.items[0], suspect);
});

test('rematchPlaylist keeps the suspect status that matching reports', async () => {
  const playlist = playlistOf([item({ title: '十年', artist: 'Someone Else' })]);
  const { playlist: next, added } = await rematchPlaylist(playlist, TRACKS);

  assert.equal(added, 1);
  assert.equal(next.items[0].status, 'suspect');
  assert.equal(next.items[0].matchedTrackId, 'fsa:Music/Eason.mp3');
  assert.deepEqual(next.items[0].reasons, ['artist']);
});
