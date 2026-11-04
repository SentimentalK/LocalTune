import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePlaylistText,
  detectOrder,
  parseDuration,
} from '../src/core/playlist/parse-text.js';

const TEN_LINES = [
  '周杰伦 - 晴天',
  '宇多田ヒカル - First Love',
  'Daft Punk - One More Time',
  'Beyond - 海阔天空',
  '坂本龍一 - Merry Christmas Mr. Lawrence',
  'Taylor Swift - Anti-Hero',
  '陈奕迅 - 富士山下',
  'Nujabes - Feather',
  '王菲 - 匆匆那年',
  'Radiohead - Creep',
].join('\n');

test('parses ten dashed lines in input order', () => {
  const result = parsePlaylistText(TEN_LINES);
  assert.equal(result.items.length, 10);
  assert.deepEqual(
    result.items.map((item) => item.title),
    [
      '晴天',
      'First Love',
      'One More Time',
      '海阔天空',
      'Merry Christmas Mr. Lawrence',
      'Anti-Hero',
      '富士山下',
      'Feather',
      '匆匆那年',
      'Creep',
    ],
  );
  assert.equal(result.items[0].artist, '周杰伦');
  assert.equal(result.items[1].artist, '宇多田ヒカル');
  assert.equal(result.items[4].artist, '坂本龍一');
  assert.equal(result.delimiter, 'dash');
  assert.equal(result.order, 'artist-title');
  assert.deepEqual(result.warnings, []);
});

test('detects title-artist when known artists match the second column', () => {
  const text = ['晴天 - 周杰伦', 'First Love - 宇多田ヒカル', 'Creep - Radiohead'].join('\n');
  const result = parsePlaylistText(text, {
    knownArtists: ['周杰伦', '宇多田ヒカル', 'Radiohead'],
  });
  assert.equal(result.order, 'title-artist');
  assert.deepEqual(
    result.items.map((item) => [item.title, item.artist]),
    [
      ['晴天', '周杰伦'],
      ['First Love', '宇多田ヒカル'],
      ['Creep', 'Radiohead'],
    ],
  );
});

test('defaults to artist-title without known artists', () => {
  const result = parsePlaylistText('晴天 - 周杰伦');
  assert.equal(result.order, 'artist-title');
  assert.equal(result.items[0].artist, '晴天');
  assert.equal(result.items[0].title, '周杰伦');
});

test('explicit order overrides automatic detection', () => {
  const result = parsePlaylistText('晴天 - 周杰伦', {
    order: 'title-artist',
    knownArtists: ['晴天'],
  });
  assert.equal(result.order, 'title-artist');
  assert.equal(result.items[0].title, '晴天');
  assert.equal(result.items[0].artist, '周杰伦');

  const forced = parsePlaylistText('晴天 - 周杰伦', {
    order: 'artist-title',
    knownArtists: ['周杰伦'],
  });
  assert.equal(forced.order, 'artist-title');
  assert.equal(forced.items[0].artist, '晴天');
});

test('detectOrder is exported and compares both columns', () => {
  const rows = [
    { a: '晴天', b: '周杰伦' },
    { a: 'Creep', b: 'Radiohead' },
  ];
  assert.equal(detectOrder(rows, { knownArtists: ['周杰伦', 'Radiohead'] }), 'title-artist');
  assert.equal(detectOrder(rows, { knownArtists: ['晴天', 'Creep'] }), 'artist-title');
  assert.equal(detectOrder(rows, { knownArtists: [] }), 'artist-title');
  assert.equal(detectOrder([], { knownArtists: ['周杰伦'] }), 'artist-title');
});

test('detectOrder trims and lowercases before matching', () => {
  const rows = [{ a: '  queen ', b: 'Bohemian Rhapsody' }];
  assert.equal(detectOrder(rows, { knownArtists: [' Queen '] }), 'artist-title');
  const swapped = [{ a: 'Bohemian Rhapsody', b: 'QUEEN' }];
  assert.equal(detectOrder(swapped, { knownArtists: ['queen'] }), 'title-artist');
});

test('tab separated rows split on the first tab', () => {
  const result = parsePlaylistText('周杰伦\t晴天\nRadiohead\tCreep');
  assert.equal(result.delimiter, 'tab');
  assert.deepEqual(
    result.items.map((item) => [item.artist, item.title]),
    [
      ['周杰伦', '晴天'],
      ['Radiohead', 'Creep'],
    ],
  );
});

test('comma separated rows use two columns', () => {
  const result = parsePlaylistText('周杰伦,晴天\nRadiohead,Creep');
  assert.equal(result.delimiter, 'comma');
  assert.deepEqual(
    result.items.map((item) => [item.artist, item.title]),
    [
      ['周杰伦', '晴天'],
      ['Radiohead', 'Creep'],
    ],
  );
});

test('mixed delimiters report mixed', () => {
  const result = parsePlaylistText('A - B\nC\tD\nE,F');
  assert.equal(result.delimiter, 'mixed');
  assert.equal(result.items.length, 3);
});

test('quoted CSV fields keep their content', () => {
  const result = parsePlaylistText('"Simon & Garfunkel","The Boxer"');
  assert.equal(result.delimiter, 'comma');
  assert.equal(result.items[0].artist, 'Simon & Garfunkel');
  assert.equal(result.items[0].title, 'The Boxer');
});

test('commas inside quotes do not split columns and dashes stay literal', () => {
  const result = parsePlaylistText('"A, B - C",Title');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].artist, 'A, B - C');
  assert.equal(result.items[0].title, 'Title');
});

test('quoted CSV rows parse a third duration column', () => {
  const result = parsePlaylistText('"Simon & Garfunkel","The Boxer",3:45');
  assert.equal(result.items[0].durationMs, 225000);
});

test('dash splits only at the first separator', () => {
  const result = parsePlaylistText('AC/DC - Back in Black');
  assert.equal(result.items[0].artist, 'AC/DC');
  assert.equal(result.items[0].title, 'Back in Black');

  const double = parsePlaylistText('A - B - C');
  assert.equal(double.items[0].artist, 'A');
  assert.equal(double.items[0].title, 'B - C');
});

test('en dash, em dash and full-width hyphen separate columns', () => {
  assert.equal(parsePlaylistText('AC/DC – Back in Black').items[0].artist, 'AC/DC');
  assert.equal(parsePlaylistText('AC/DC — Back in Black').items[0].title, 'Back in Black');
  assert.equal(parsePlaylistText('AC/DC － Back in Black').items[0].artist, 'AC/DC');
  assert.equal(parsePlaylistText('AC/DC － Back in Black').delimiter, 'dash');
});

test('a bare dash without surrounding spaces is not a separator', () => {
  const result = parsePlaylistText('AC/DC-Back in Black');
  assert.equal(result.delimiter, 'none');
  assert.equal(result.items[0].title, 'AC/DC-Back in Black');
  assert.equal(result.items[0].artist, '');
});

test('single column lines become titles', () => {
  const result = parsePlaylistText('晴天');
  assert.equal(result.delimiter, 'none');
  assert.equal(result.items[0].title, '晴天');
  assert.equal(result.items[0].artist, '');
  assert.equal(result.items[0].durationMs, null);
});

test('tab row with dashed artist keeps the duration column', () => {
  const result = parsePlaylistText('A - B\t3:45');
  assert.equal(result.delimiter, 'tab');
  assert.equal(result.items[0].artist, 'A');
  assert.equal(result.items[0].title, 'B');
  assert.equal(result.items[0].durationMs, 225000);
});

test('comma row reads the third column as seconds when numeric', () => {
  const result = parsePlaylistText('A,B,225');
  assert.equal(result.items[0].artist, 'A');
  assert.equal(result.items[0].title, 'B');
  assert.equal(result.items[0].durationMs, 225000);
});

test('invalid third column is ignored without a warning', () => {
  const result = parsePlaylistText('A,B,oops');
  assert.equal(result.items[0].durationMs, null);
  assert.deepEqual(result.warnings, []);
});

test('parseDuration accepts m:ss, h:mm:ss and plain seconds', () => {
  assert.equal(parseDuration('3:45'), 225000);
  assert.equal(parseDuration('1:02:03'), 3723000);
  assert.equal(parseDuration('225'), 225000);
  assert.equal(parseDuration('0:00'), 0);
});

test('parseDuration rejects malformed values', () => {
  assert.equal(parseDuration('3:75'), null);
  assert.equal(parseDuration('1:75:03'), null);
  assert.equal(parseDuration('1:02:75'), null);
  assert.equal(parseDuration('-3:45'), null);
  assert.equal(parseDuration(''), null);
  assert.equal(parseDuration('3:4'), null);
  assert.equal(parseDuration('abc'), null);
  assert.equal(parseDuration(null), null);
});

test('blank lines and hash comments are skipped silently', () => {
  const text = '# my playlist\n\n周杰伦 - 晴天\n\n# another note\nRadiohead - Creep\n';
  const result = parsePlaylistText(text);
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.items[0].raw, '周杰伦 - 晴天');
});

test('skipped warnings use 1-based line numbers', () => {
  const result = parsePlaylistText('# c\nA - B\n,\nC - D');
  assert.deepEqual(result.warnings, ['skipped:3']);
  assert.equal(result.items.length, 2);
});

test('empty comma pair is reported with its line number', () => {
  const result = parsePlaylistText('A,B\n,\nC,D');
  assert.deepEqual(result.warnings, ['skipped:2']);
  assert.equal(result.items.length, 2);
});

test('empty text yields the documented empty result', () => {
  assert.deepEqual(parsePlaylistText(''), {
    items: [],
    delimiter: 'none',
    order: 'artist-title',
    warnings: [],
  });
});

test('whitespace only text yields no items', () => {
  const result = parsePlaylistText('   \n\t\n  ');
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.delimiter, 'none');
});

test('collapses runs of spaces in both columns', () => {
  const result = parsePlaylistText('  A   B  -   C   D  ');
  assert.equal(result.items[0].artist, 'A B');
  assert.equal(result.items[0].title, 'C D');
  assert.equal(result.items[0].raw, 'A   B  -   C   D');
});

test('carriage returns are stripped', () => {
  const result = parsePlaylistText('周杰伦 - 晴天\r\nRadiohead - Creep\r\n');
  assert.equal(result.items.length, 2);
  assert.equal(result.items[1].raw, 'Radiohead - Creep');
});

test('equal hits on both columns warn once about ambiguous order', () => {
  const text = ['Queen - A', 'B - Queen'].join('\n');
  const result = parsePlaylistText(text, { knownArtists: ['Queen'] });
  assert.equal(result.order, 'artist-title');
  assert.deepEqual(result.warnings, ['ambiguous-order']);

  const single = parsePlaylistText('Queen - A', { knownArtists: ['Queen'] });
  assert.deepEqual(single.warnings, []);
});

test('no ambiguity warning when an explicit order was given', () => {
  const text = ['Queen - A', 'B - Queen'].join('\n');
  const result = parsePlaylistText(text, {
    order: 'title-artist',
    knownArtists: ['Queen'],
  });
  assert.equal(result.order, 'title-artist');
  assert.deepEqual(result.warnings, []);
});
