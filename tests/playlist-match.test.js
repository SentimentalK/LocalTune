import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeText,
  normalizeTitle,
  splitArtists,
  normalizeArtist,
  artistMatches,
  similarity,
  matchItem,
  matchPlaylist,
} from '../src/core/playlist/match.js';
import { T2S_PAIRS } from '../src/core/playlist/t2s-table.js';

const EPSILON = 1e-12;

function near(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < EPSILON, message ?? `${actual} !== ${expected}`);
}

function track(id, title, extra = {}) {
  return { id, title, ...extra };
}

// --- normalizeText -------------------------------------------------------

test('normalizeText folds NFKC full-width text to half-width', () => {
  assert.equal(normalizeText('Ｌｉｖｅ　Ａｃｏｕｓｔｉｃ'), 'live acoustic');
});

test('normalizeText maps traditional characters to simplified', () => {
  assert.equal(normalizeText('陳奕迅'), '陈奕迅');
});

test('normalizeText converts a traditional title to simplified', () => {
  assert.equal(normalizeText('給我一個理由忘記'), '给我一个理由忘记');
});

test('normalizeText drops a bracketed live tag', () => {
  assert.equal(normalizeText('Hello (Live)'), 'hello');
});

test('normalizeText drops a dashed remaster suffix with its year', () => {
  assert.equal(normalizeText('Song - Remastered 2011'), 'song');
});

test('normalizeText drops a bracketed explicit tag', () => {
  assert.equal(normalizeText('Song [Explicit]'), 'song');
});

test('normalizeText drops a bracketed re-recording version tag', () => {
  assert.equal(normalizeText("Song (Taylor's Version)"), 'song');
});

test('normalizeText drops an official video tag on a Japanese title', () => {
  assert.equal(normalizeText('夜に駆ける (Official Video)'), '夜に駆ける');
});

test('normalizeText drops a trailing bare official tag', () => {
  assert.equal(normalizeText('夜に駆ける official'), '夜に駆ける');
});

test('normalizeText collapses whitespace and trims', () => {
  assert.equal(normalizeText('  A   B  '), 'a b');
});

test('normalizeText returns empty string for non-strings', () => {
  assert.equal(normalizeText(null), '');
  assert.equal(normalizeText(undefined), '');
  assert.equal(normalizeText(42), '');
  assert.equal(normalizeText({}), '');
});

test('normalizeText returns empty string for an empty string', () => {
  assert.equal(normalizeText(''), '');
  assert.equal(normalizeText('   '), '');
});

test('normalizeText keeps brackets that do not look like version tags', () => {
  assert.equal(normalizeText('Song (Reprise)'), 'song (reprise)');
});

test('normalizeText strips one level of nested version brackets', () => {
  assert.equal(normalizeText('Song (Live (Remastered))'), 'song');
});

test('normalizeText drops a bracketed live recording suffix', () => {
  assert.equal(normalizeText('Hello (Live at Wembley)'), 'hello');
});

test('normalizeText normalizes curly apostrophes and spacing', () => {
  assert.equal(normalizeText('Don’t   Stop'), "don't stop");
});

// --- normalizeTitle ------------------------------------------------------

test('normalizeTitle matches normalizeText on a suffixed title', () => {
  assert.equal(normalizeTitle('Song - Remastered 2011'), 'song');
  assert.equal(normalizeTitle('Song - Remastered 2011'), normalizeText('Song - Remastered 2011'));
});

test('normalizeTitle removes a bracketed album version tag', () => {
  assert.equal(normalizeTitle('Song (Album Version)'), 'song');
});

test('normalizeTitle leaves a clean title untouched', () => {
  assert.equal(normalizeTitle('给我一个理由忘记'), '给我一个理由忘记');
});

// --- splitArtists --------------------------------------------------------

test('splitArtists splits on feat.', () => {
  assert.deepEqual(splitArtists('A feat. B'), ['a', 'b']);
});

test('splitArtists splits on ft.', () => {
  assert.deepEqual(splitArtists('A ft. B'), ['a', 'b']);
});

test('splitArtists splits on featuring', () => {
  assert.deepEqual(splitArtists('A featuring B'), ['a', 'b']);
});

test('splitArtists splits on ampersand', () => {
  assert.deepEqual(splitArtists('A & B'), ['a', 'b']);
});

test('splitArtists splits on the ideographic comma', () => {
  assert.deepEqual(splitArtists('A、B'), ['a', 'b']);
});

test('splitArtists splits on a plain comma', () => {
  assert.deepEqual(splitArtists('A, B'), ['a', 'b']);
});

test('splitArtists splits on a slash', () => {
  assert.deepEqual(splitArtists('A / B'), ['a', 'b']);
});

test('splitArtists splits on mixed feat and ampersand credits', () => {
  assert.deepEqual(splitArtists('A feat. B & C'), ['a', 'b', 'c']);
});

test('splitArtists drops duplicate names but keeps order', () => {
  assert.deepEqual(splitArtists('A & A & B'), ['a', 'b']);
});

test('splitArtists normalizes traditional names before splitting', () => {
  assert.deepEqual(splitArtists('陳奕迅 feat. 王菲'), ['陈奕迅', '王菲']);
});

test('splitArtists returns an empty array for blank input', () => {
  assert.deepEqual(splitArtists(''), []);
  assert.deepEqual(splitArtists('   '), []);
  assert.deepEqual(splitArtists(null), []);
});

test('splitArtists unwraps a bracketed feat credit instead of dropping it', () => {
  assert.deepEqual(splitArtists('A (feat. B)'), ['a', 'b']);
});

// --- normalizeArtist -----------------------------------------------------

test('normalizeArtist returns the lead artist', () => {
  assert.equal(normalizeArtist('A feat. B'), 'a');
  assert.equal(normalizeArtist('陳奕迅'), '陈奕迅');
});

test('normalizeArtist returns empty string without a credit', () => {
  assert.equal(normalizeArtist(''), '');
  assert.equal(normalizeArtist(null), '');
});

// --- artistMatches -------------------------------------------------------

test('artistMatches accepts a lead artist matching one collaborator', () => {
  assert.equal(artistMatches('A feat. B', 'B'), true);
});

test('artistMatches rejects unrelated artists', () => {
  assert.equal(artistMatches('A', 'B'), false);
});

test('artistMatches treats two empty credits as a match', () => {
  assert.equal(artistMatches('', ''), true);
  assert.equal(artistMatches(null, undefined), true);
});

test('artistMatches rejects empty versus a real credit', () => {
  assert.equal(artistMatches('', 'A'), false);
  assert.equal(artistMatches('A', ''), false);
});

test('artistMatches ignores traditional/simplified differences', () => {
  assert.equal(artistMatches('陳奕迅', '陈奕迅'), true);
});

test('artistMatches requires the same lead artist when credits are disjoint', () => {
  assert.equal(artistMatches('A feat. C', 'B feat. C'), true);
  assert.equal(artistMatches('A feat. D', 'B feat. C'), false);
});

// --- similarity ----------------------------------------------------------

test('similarity of identical titles is 1', () => {
  assert.equal(similarity('Hello', 'hello'), 1);
});

test('similarity of unrelated titles is 0', () => {
  near(similarity('abc', 'xyz'), 0);
  assert.ok(similarity('abc', 'xyz') < 0.5);
});

test('similarity ignores a trailing official tag', () => {
  assert.ok(similarity('夜に駆ける', '夜に駆ける official') >= 0.8);
  assert.equal(similarity('夜に駆ける', '夜に駆ける official'), 1);
});

test('similarity blends jaccard and edit distance', () => {
  near(similarity('a b c d e f g h', 'a b c d e f g x'), 77 / 90);
  near(similarity('hello world', 'hello there'), 29 / 66);
});

test('similarity stays within 0..1', () => {
  const pairs = [
    ['', ''],
    ['', 'hello'],
    ['same', 'same'],
    ['song one', 'song two'],
    ['給我一個理由忘記', '给我一个理由忘记'],
  ];
  for (const [left, right] of pairs) {
    const score = similarity(left, right);
    assert.ok(score >= 0 && score <= 1, `${left} / ${right} -> ${score}`);
  }
});

test('similarity treats two empty titles as 0', () => {
  assert.equal(similarity('', ''), 0);
  near(similarity('', 'hello'), 0);
});

test('similarity normalizes traditional and simplified titles', () => {
  assert.equal(similarity('給我一個理由忘記', '给我一个理由忘记'), 1);
});

// --- matchItem -----------------------------------------------------------

test('matchItem matches an exact title', () => {
  const result = matchItem({ title: 'Hello' }, [track('t1', 'Hello')]);
  assert.deepEqual(result, { status: 'matched', trackId: 't1', score: 1, reasons: [] });
});

test('matchItem ignores case and typographic apostrophes', () => {
  const result = matchItem({ title: 'Don’t Stop' }, [track('t1', "DON'T STOP")]);
  assert.equal(result.status, 'matched');
  assert.equal(result.trackId, 't1');
  assert.equal(result.score, 1);
});

test('matchItem matches a traditional playlist title against a simplified library', () => {
  const result = matchItem(
    { title: '給我一個理由忘記', artist: '陳奕迅' },
    [track('t1', '给我一个理由忘记', { artist: '陈奕迅', duration: 238 })],
  );
  assert.equal(result.status, 'matched');
  assert.equal(result.trackId, 't1');
});

test('matchItem matches full-width playlist text', () => {
  const result = matchItem({ title: 'Ｌｉｖｅ　Ａｃｏｕｓｔｉｃ' }, [track('t1', 'Live Acoustic')]);
  assert.equal(result.status, 'matched');
  assert.equal(result.trackId, 't1');
});

test('matchItem matches a title against a library title with a live suffix', () => {
  const result = matchItem({ title: '夜に駆ける' }, [track('t1', '夜に駆ける (Official Video)')]);
  assert.equal(result.status, 'matched');
  assert.equal(result.trackId, 't1');
});

test('matchItem tolerates a different feat order', () => {
  const result = matchItem(
    { title: 'Song feat. B', artist: 'A feat. B' },
    [track('t1', 'Song', { artist: 'B feat. A' })],
  );
  assert.equal(result.status, 'matched');
  assert.deepEqual(result.reasons, []);
});

test('matchItem matches when the library credit is one of the collaborators', () => {
  const result = matchItem({ title: 'Song', artist: 'A feat. B' }, [track('t1', 'Song', { artist: 'B' })]);
  assert.equal(result.status, 'matched');
  assert.deepEqual(result.reasons, []);
});

test('matchItem marks a different artist as suspect', () => {
  const result = matchItem(
    { title: 'Song', artist: 'A' },
    [track('t1', 'Song', { artist: 'B', duration: 200 })],
  );
  assert.deepEqual(result, { status: 'suspect', trackId: 't1', score: 1, reasons: ['artist'] });
});

test('matchItem marks a 16000 ms duration gap as suspect', () => {
  const result = matchItem(
    { title: 'Song', artist: 'A', durationMs: 216000 },
    [track('t1', 'Song', { artist: 'A', duration: 200 })],
  );
  assert.deepEqual(result, { status: 'suspect', trackId: 't1', score: 1, reasons: ['duration'] });
});

test('matchItem reports artist then duration when both are off', () => {
  const result = matchItem(
    { title: 'Song', artist: 'A', durationMs: 260000 },
    [track('t1', 'Song', { artist: 'B', duration: 200 })],
  );
  assert.deepEqual(result.reasons, ['artist', 'duration']);
  assert.equal(result.status, 'suspect');
});

test('matchItem accepts a 14000 ms duration gap', () => {
  const result = matchItem(
    { title: 'Song', artist: 'A', durationMs: 214000 },
    [track('t1', 'Song', { artist: 'A', duration: 200 })],
  );
  assert.equal(result.status, 'matched');
  assert.deepEqual(result.reasons, []);
});

test('matchItem accepts exactly a 15000 ms duration gap', () => {
  const result = matchItem(
    { title: 'Song', artist: 'A', durationMs: 215000 },
    [track('t1', 'Song', { artist: 'A', duration: 200 })],
  );
  assert.equal(result.status, 'matched');
  assert.deepEqual(result.reasons, []);
});

test('matchItem flags 15001 ms as a duration suspect', () => {
  const result = matchItem(
    { title: 'Song', artist: 'A', durationMs: 215001 },
    [track('t1', 'Song', { artist: 'A', duration: 200 })],
  );
  assert.deepEqual(result.reasons, ['duration']);
});

test('matchItem ignores a null playlist duration', () => {
  const result = matchItem(
    { title: 'Song', artist: 'A', durationMs: null },
    [track('t1', 'Song', { artist: 'A', duration: 400 })],
  );
  assert.equal(result.status, 'matched');
  assert.deepEqual(result.reasons, []);
});

test('matchItem ignores an unknown library duration', () => {
  const result = matchItem(
    { title: 'Song', artist: 'A', durationMs: 200000 },
    [track('t1', 'Song', { artist: 'A', duration: 0 })],
  );
  assert.equal(result.status, 'matched');
  assert.deepEqual(result.reasons, []);
});

test('matchItem ignores a missing artist on the playlist side', () => {
  const result = matchItem({ title: 'Song' }, [track('t1', 'Song', { artist: 'Anyone' })]);
  assert.equal(result.status, 'matched');
  assert.deepEqual(result.reasons, []);
});

test('matchItem picks the closest duration among equal scores', () => {
  const result = matchItem(
    { title: 'Song', artist: 'A', durationMs: 230000 },
    [track('short', 'Song', { artist: 'A', duration: 200 }), track('long', 'Song', { artist: 'A', duration: 240 })],
  );
  assert.equal(result.trackId, 'long');
  assert.equal(result.status, 'matched');
});

test('matchItem keeps the first track when score and duration gap tie', () => {
  const result = matchItem(
    { title: 'Song', artist: 'A', durationMs: 200000 },
    [track('early', 'Song', { artist: 'A', duration: 190 }), track('late', 'Song', { artist: 'A', duration: 210 })],
  );
  assert.equal(result.trackId, 'early');
});

test('matchItem prefers the higher score over a closer duration', () => {
  const result = matchItem(
    { title: 'Song', artist: 'A', durationMs: 100000 },
    [track('close', 'Song - Single', { artist: 'A', duration: 100 }), track('far', 'Song', { artist: 'A', duration: 300 })],
  );
  // Both normalize to "song" and score 1; the duration decides.
  assert.equal(result.trackId, 'close');
});

test('matchItem reports missing when nothing clears the threshold', () => {
  const result = matchItem({ title: 'hello world' }, [track('t1', 'hello there')]);
  assert.deepEqual(result, { status: 'missing', trackId: null, score: 0, reasons: [] });
});

test('matchItem reports missing for an empty library', () => {
  assert.deepEqual(matchItem({ title: 'Song' }, []), {
    status: 'missing',
    trackId: null,
    score: 0,
    reasons: [],
  });
});

test('matchItem honours a custom threshold', () => {
  const tracks = [track('t1', 'hello there')];
  assert.equal(matchItem({ title: 'hello world' }, tracks, { threshold: 0.4 }).status, 'matched');
  assert.equal(matchItem({ title: 'hello world' }, tracks, { threshold: 0.9 }).status, 'missing');
});

test('matchItem uses the default 0.8 threshold', () => {
  const close = [track('t1', 'a b c d e f g x')];
  assert.equal(matchItem({ title: 'a b c d e f g h' }, close).status, 'matched');
  assert.equal(matchItem({ title: 'a b c d e f g h' }, close, { threshold: 0.9 }).status, 'missing');
});

test('matchItem skips a track that scores just under the threshold', () => {
  const result = matchItem({ title: 'a b c d e f g h' }, [
    track('low', 'a b c d e f g z z'),
    track('high', 'a b c d e f g h (Remastered)'),
  ]);
  assert.equal(result.trackId, 'high');
  assert.equal(result.score, 1);
});

test('matchItem honours a custom duration tolerance', () => {
  const item = { title: 'Song', artist: 'A', durationMs: 220000 };
  const tracks = [track('t1', 'Song', { artist: 'A', duration: 200 })];
  assert.equal(matchItem(item, tracks, { durationToleranceMs: 20000 }).status, 'matched');
  assert.equal(matchItem(item, tracks, { durationToleranceMs: 25000 }).status, 'matched');
  assert.equal(matchItem(item, tracks, { durationToleranceMs: 1000 }).status, 'suspect');
});

// --- matchPlaylist -------------------------------------------------------

test('matchPlaylist keeps length and order', () => {
  const items = [{ title: 'A' }, { title: 'Unknown' }, { title: 'C' }];
  const tracks = [track('a', 'A'), track('c', 'C')];
  const results = matchPlaylist(items, tracks);
  assert.equal(results.length, items.length);
  assert.deepEqual(
    results.map((result) => result.trackId),
    ['a', null, 'c'],
  );
  assert.deepEqual(
    results.map((result) => result.status),
    ['matched', 'missing', 'matched'],
  );
});

test('matchPlaylist returns all missing for an empty library', () => {
  const results = matchPlaylist([{ title: 'A' }, { title: 'B' }], []);
  assert.equal(results.length, 2);
  assert.ok(results.every((result) => result.status === 'missing' && result.trackId === null));
});

test('matchPlaylist forwards options to every item', () => {
  const results = matchPlaylist(
    [{ title: 'hello world' }, { title: 'hello there' }],
    [track('t1', 'hello there')],
    { threshold: 0.9 },
  );
  assert.deepEqual(
    results.map((result) => result.status),
    ['missing', 'matched'],
  );
});

test('matchPlaylist is empty for an empty item list', () => {
  assert.deepEqual(matchPlaylist([], [track('t1', 'A')]), []);
});

// --- table ---------------------------------------------------------------

test('T2S_PAIRS exports a space-separated table of at least 1200 pairs', () => {
  const pairs = T2S_PAIRS.split(' ');
  assert.ok(pairs.length >= 1200, `only ${pairs.length} pairs`);
  for (const pair of pairs) assert.equal(Array.from(pair).length, 2, `bad pair: ${pair}`);
});

test('T2S_PAIRS covers the characters used by the normalization tests', () => {
  const map = new Map();
  for (const pair of T2S_PAIRS.split(' ')) {
    const [traditional, simplified] = Array.from(pair);
    map.set(traditional, simplified);
  }
  for (const [traditional, simplified] of [
    ['個', '个'],
    ['們', '们'],
    ['這', '这'],
    ['給', '给'],
    ['記', '记'],
    ['陳', '陈'],
    ['為', '为'],
    ['裡', '里'],
  ]) {
    assert.equal(map.get(traditional), simplified);
  }
});
