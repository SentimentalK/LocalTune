import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEMO_BY_ID, DEMO_FADE_SECONDS, DEMO_TRACKS, demoEndFade } from '../src/core/demo.js';

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

test('the demo queue is the four requested tracks in order', () => {
  assert.deepEqual(
    DEMO_TRACKS.map((track) => track.title),
    ['Baby Girl', 'JUST COMMUNICATION', 'ハチミツ', '自由的你'],
  );
  assert.deepEqual(
    DEMO_TRACKS.map((track) => track.path),
    ['demo/baby-girl.mp3', 'demo/just-communication.mp3', 'demo/hachimitsu.mp3', 'demo/ziyou-de-ni.mp3'],
  );
  for (const track of DEMO_TRACKS) {
    // The stage cover is content-addressed; the row thumbnail is its -96 twin.
    assert.match(track.coverSrc, /^\.\/demo\/[a-z-]+\.[0-9a-f]{8}\.webp$/);
    assert.match(track.coverThumb, /^\.\/demo\/[a-z-]+\.[0-9a-f]{8}-96\.webp$/);
    assert.ok(existsSync(path.join(srcDir, track.coverSrc)), `missing ${track.coverSrc}`);
    assert.ok(existsSync(path.join(srcDir, track.coverThumb)), `missing ${track.coverThumb}`);
  }
  assert.deepEqual(
    DEMO_TRACKS.map((track) => track.duration),
    [273, 30, 30, 30],
  );
  assert.equal(DEMO_TRACKS[0].artist, '方大同');
  assert.equal(DEMO_TRACKS[3].artist, 'G.E.M.');
  assert.equal(DEMO_BY_ID.get('demo:baby-girl'), DEMO_TRACKS[0]);
  assert.equal(DEMO_BY_ID.has('demo:qingtian'), false);
});

test('only the 30 s demos fade over the last 1.5 s of playback', () => {
  assert.equal(DEMO_FADE_SECONDS, 1.5);
  const short = DEMO_BY_ID.get('demo:just-communication');

  assert.equal(demoEndFade(short, 27.9, 30), 1);
  assert.equal(demoEndFade(short, 28.5, 30), 1);
  assert.equal(demoEndFade(short, 29.25, 30), 0.5);
  assert.equal(demoEndFade(short, 30, 30), 0);

  // Baby Girl is full length and never fades.
  const long = DEMO_BY_ID.get('demo:baby-girl');
  assert.equal(demoEndFade(long, 272.8, 273), 1);

  // Non-demo tracks never fade, even when short.
  assert.equal(demoEndFade({ id: 'fsa:a.mp3', duration: 30 }, 29.8, 30), 1);

  // Unknown duration must not mute anything.
  assert.equal(demoEndFade(short, 0, 0), 1);
});
