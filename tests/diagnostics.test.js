import { test } from 'node:test';
import assert from 'node:assert/strict';

import { describeId3 } from '../src/core/metadata/id3.js';
import { formatTagReport } from '../src/core/metadata/diagnostics.js';

/** 'ID3' with ID3v2.3 and no flags; the size is syncsafe. */
function id3v23(frames) {
  const body = frames.flat();
  const size = body.length;
  return new Uint8Array([
    0x49,
    0x44,
    0x33,
    0x03,
    0x00,
    0x00,
    (size >> 21) & 0x7f,
    (size >> 14) & 0x7f,
    (size >> 7) & 0x7f,
    size & 0x7f,
    ...body,
  ]);
}

function frame(id, data) {
  const header = [...id].map((char) => char.charCodeAt(0));
  const size = data.length;
  header.push((size >>> 24) & 0xff, (size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff, 0, 0);
  return [...header, ...data];
}

const GBK_ZHONG_WEN = [0x00, 0xd6, 0xd0, 0xce, 0xc4]; // encoding 0, GBK for 中文

test('describeId3 lists encoding-0 text frames with every legacy candidate', () => {
  const bytes = id3v23([frame('TIT2', GBK_ZHONG_WEN)]);
  const described = describeId3(bytes);

  assert.equal(described.version, 3);
  assert.equal(described.id3v1, null);
  assert.equal(described.frames.length, 1);

  const [tit2] = described.frames;
  assert.equal(tit2.id, 'TIT2');
  assert.equal(tit2.encoding, 0);
  assert.equal(tit2.decoded, '中文');
  assert.equal(tit2.rawHex32, '00 d6 d0 ce c4');
  assert.deepEqual(
    tit2.candidates.map((candidate) => candidate.label),
    ['utf-8', 'shift_jis', 'gb18030', 'big5', 'euc-kr', 'latin1'],
  );

  const gb = tit2.candidates.find((candidate) => candidate.label === 'gb18030');
  assert.equal(gb.text, '中文');
  assert.equal(gb.score, Math.max(...tit2.candidates.map((candidate) => candidate.score)));
  assert.ok(tit2.candidates.some((candidate) => candidate.score < gb.score));

  const utf8 = tit2.candidates.find((candidate) => candidate.label === 'utf-8');
  assert.equal(utf8.text, '');
  assert.equal(utf8.score, 0);
});

test('describeId3 reports UTF-8 frames with a single candidate', () => {
  const payload = [0x03, ...new TextEncoder().encode('歌手')];
  const described = describeId3(id3v23([frame('TPE1', payload)]));

  const [tpe1] = described.frames;
  assert.equal(tpe1.id, 'TPE1');
  assert.equal(tpe1.encoding, 3);
  assert.equal(tpe1.decoded, '歌手');
  assert.deepEqual(tpe1.candidates, [{ label: 'utf-8', text: '歌手', score: 1 }]);
});

test('describeId3 reports the ID3v1 tag separately', () => {
  const tail = new Uint8Array(128);
  tail.set([0x54, 0x41, 0x47], 0); // TAG
  tail.set([...new TextEncoder().encode('Legacy title')], 3);
  const described = describeId3(id3v23([frame('TIT2', GBK_ZHONG_WEN)]), { tail });

  assert.deepEqual(described.id3v1, { title: 'Legacy title', artist: '', album: '' });
});

test('formatTagReport prints version, frame id, encoding, hex and candidates', () => {
  const described = {
    id3v2: describeId3(id3v23([frame('TIT2', GBK_ZHONG_WEN)])),
    id3v1: null,
    chosen: { title: '中文', artist: '歌手', album: '专辑' },
  };
  described.id3v2 = { version: described.id3v2.version, frames: described.id3v2.frames };

  const report = formatTagReport(described);
  assert.match(report, /ID3v2: v2\.3/);
  assert.match(report, /TIT2 enc=0 raw=00 d6 d0 ce c4/);
  assert.match(report, /decoded: 中文/);
  assert.match(report, /gb18030 1\.00 中文/);
  assert.match(report, /ID3v1: none/);
  assert.match(report, /chosen: title=中文 \| artist=歌手 \| album=专辑/);
});

test('formatTagReport prints "ID3v2: none" without an ID3v2 tag', () => {
  const report = formatTagReport({
    id3v2: null,
    id3v1: null,
    chosen: { title: '', artist: '', album: '' },
  });
  assert.match(report, /^ID3v2: none$/m);
});
