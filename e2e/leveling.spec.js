import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { installGraphMock } from './support/graph-mock.js';
import { seedLocalLibrary } from './support/seed.js';

// Auto-advance and the Web Audio graph both want activation; keep playback
// going and the speakers quiet for the whole file.
test.use({
  launchOptions: { args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] },
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_MP3 = readFileSync(path.join(HERE, '..', 'tests', 'fixtures', 'sample.mp3'));

const COMPRESSOR = { threshold: -24, knee: 6, ratio: 5, attack: 0.003, release: 0.25 };
const TARGET_GAIN = 0.434; // gainFactor(-7.25)

/** An ID3v2.3 tag with `REPLAYGAIN_TRACK_GAIN` in front of the fixture. */
function withGainTag(bytes, db = -7.25) {
  const payload = Buffer.concat([
    Buffer.from([3]), // UTF-8
    Buffer.from('REPLAYGAIN_TRACK_GAIN', 'latin1'),
    Buffer.from([0]),
    Buffer.from(`${db} dB`, 'latin1'),
    Buffer.from([0]),
  ]);
  const frame = Buffer.alloc(10 + payload.length);
  frame.write('TXXX', 0, 'latin1');
  frame.writeUInt32BE(payload.length, 4);
  payload.copy(frame, 10);
  const size = frame.length;
  const header = Buffer.from([
    0x49,
    0x44,
    0x33, // "ID3"
    3,
    0,
    0,
    (size >> 21) & 0x7f,
    (size >> 14) & 0x7f,
    (size >> 7) & 0x7f,
    size & 0x7f,
  ]);
  return Buffer.concat([header, frame, bytes]);
}

const TAGGED_MP3 = withGainTag(SAMPLE_MP3);

/** Record every gain and compressor node the app builds. */
async function probeAudioGraph(page) {
  await page.addInitScript(() => {
    window.__leveling = { gains: [], compressors: [] };
    const AC = window.AudioContext;
    const createGain = AC.prototype.createGain;
    AC.prototype.createGain = function (...args) {
      const node = createGain.apply(this, args);
      window.__leveling.gains.push(node);
      return node;
    };
    const createCompressor = AC.prototype.createDynamicsCompressor;
    AC.prototype.createDynamicsCompressor = function (...args) {
      const node = createCompressor.apply(this, args);
      window.__leveling.compressors.push(node);
      return node;
    };
  });
}

async function openSettings(page) {
  if (!(await page.locator('[data-testid="settings-section-playback"]').isVisible())) {
    await page.locator('[data-testid="settings-open"]').click();
  }
  await expect(page.locator('[data-testid="settings-section-playback"]')).toBeVisible();
}

async function showFolders(page) {
  await page.locator('[data-testid="panel-open"]').click();
  await expect(page.locator('#tab-folders')).toBeVisible();
}

async function enableLeveling(page) {
  await openSettings(page);
  await page.locator('[data-testid="setting-leveling"]').click();
  await expect(page.locator('[data-testid="setting-leveling"]')).toHaveAttribute(
    'aria-checked',
    'true',
  );
}

async function expectLevelingText(page, text) {
  await openSettings(page);
  const hint = page.locator('[data-testid="leveling-mode"]');
  await expect(hint).toBeVisible();
  await expect(hint).toContainText(text);
}

/** Wait for the element to point at the expected source, then for progress. */
async function expectSource(page, fragment) {
  await expect
    .poll(() => page.evaluate(() => document.querySelector('audio')?.src ?? ''), {
      timeout: 10_000,
    })
    .toContain(fragment);
}

/** Wait for audible progress and prove the media element is actually moving. */
async function expectPlaying(page, { from = 0 } = {}) {
  await expect(page.locator('#armRotor')).toHaveAttribute('data-playing', 'true');
  await expect
    .poll(
      () => page.evaluate(() => document.querySelector('audio')?.currentTime ?? -1),
      { timeout: 10_000 },
    )
    .toBeGreaterThan(from);
}

const audioCount = (page) => page.evaluate(() => document.querySelectorAll('audio').length);

/** Walk up from whatever folder is open until the source rows show again. */
async function backToSources(page) {
  const local = page.locator('[data-testid="folder-source-local"]');
  for (let step = 0; step < 4; step += 1) {
    if (await local.isVisible()) return;
    const up = page.locator('[data-testid="folder-up"]');
    if ((await up.count()) === 0) break;
    await up.click();
  }
  await expect(local).toBeVisible();
}

async function connectOneDrive(page, mock) {
  await openSettings(page);
  await page.locator('[data-testid="source-connect-onedrive"]').click();
  await expect(page.locator('[data-testid="onedrive-picker"]')).toBeVisible();
  await page.locator('[data-testid="onedrive-folder"]').first().click();
  await expect(page.locator('[data-testid="onedrive-picker-up"]')).toBeEnabled();
  await page.locator('[data-testid="onedrive-picker-choose"]').click();
  await expect(page.locator('[data-testid="onedrive-picker"]')).toBeHidden();
  await expect(page.locator('[data-testid="source-row-onedrive"]')).toContainText('2');
  // The warm pass downloads every listed file; no cache hit before it lands.
  await expect.poll(() => mock.wholeRequests.length, { timeout: 15_000 }).toBeGreaterThan(0);
}

async function startApp(page) {
  // Force the reference local mode so the seeded `fileList` is the library.
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: undefined,
    });
  });
  await page.goto('/');
  await expect(page.locator('#status')).toBeHidden({ timeout: 10_000 });
}

test('a tagged local track drives the gain node and reports the full chain', async ({ page }) => {
  await probeAudioGraph(page);
  await startApp(page);
  await seedLocalLibrary(page, {
    files: [
      { path: 'Music/tagged.mp3', bytesBase64: TAGGED_MP3.toString('base64'), type: 'audio/mpeg' },
    ],
  });
  await page.reload();
  await enableLeveling(page);
  await showFolders(page);

  await page.locator('[data-testid="folder-source-local"]').click();
  await page.locator('[data-testid="folder-dir-Music"]').click();
  await page.locator('[data-testid="track-row"] .track').first().click();
  await expectSource(page, 'blob:');
  await expectPlaying(page);

  await expect
    .poll(() => page.evaluate(() => window.__leveling.gains.at(-1)?.gain.value ?? null), {
      timeout: 10_000,
    })
    .not.toBeNull();
  const value = await page.evaluate(() => window.__leveling.gains.at(-1).gain.value);
  expect(Math.abs(value - TARGET_GAIN)).toBeLessThan(0.005);

  await expectLevelingText(page, '全链');
});

test('an untagged local track keeps the compressor and narrows the range', async ({ page }) => {
  await probeAudioGraph(page);
  await startApp(page);
  await seedLocalLibrary(page);
  await page.reload();
  await enableLeveling(page);
  await showFolders(page);

  await page.locator('[data-testid="folder-source-local"]').click();
  await page.locator('[data-testid="folder-dir-Music"]').click();
  await page.locator('[data-testid="track-row"] .track').first().click();
  await expectSource(page, 'blob:');
  await expectPlaying(page);

  expect(await page.evaluate(() => window.__leveling.compressors.length)).toBe(1);
  expect(await audioCount(page)).toBe(1);

  // Render the same signal through a compressor built from the live node's
  // own parameters: 2 s quiet, 2 s loud, 220 Hz.
  const rendered = await page.evaluate(async () => {
    const live = window.__leveling.compressors.at(-1);
    const params = {
      threshold: live.threshold.value,
      knee: live.knee.value,
      ratio: live.ratio.value,
      attack: live.attack.value,
      release: live.release.value,
    };
    const trackGain = window.__leveling.gains.at(-1)?.gain.value ?? 1;
    const rate = 44100;
    const seconds = 4;
    const offline = new OfflineAudioContext(1, rate * seconds, rate);
    const osc = offline.createOscillator();
    osc.frequency.value = 220;
    const amp = offline.createGain();
    amp.gain.setValueAtTime(0.02, 0);
    amp.gain.setValueAtTime(0.85, 2);
    const gain = offline.createGain();
    gain.gain.value = trackGain;
    const compressor = offline.createDynamicsCompressor();
    for (const [key, value] of Object.entries(params)) compressor[key].value = value;
    osc.connect(amp);
    amp.connect(gain);
    gain.connect(compressor);
    compressor.connect(offline.destination);
    osc.start(0);
    osc.stop(seconds);
    const buffer = await offline.startRendering();
    const data = buffer.getChannelData(0);
    const rms = (from, to) => {
      const start = Math.floor(from * rate);
      const end = Math.floor(to * rate);
      let sum = 0;
      for (let index = start; index < end; index += 1) sum += data[index] ** 2;
      return Math.sqrt(sum / (end - start));
    };
    let peak = 0;
    for (const sample of data) peak = Math.max(peak, Math.abs(sample));
    return { params, trackGain, quiet: rms(0.25, 1.75), loud: rms(2.25, 3.75), peak };
  });

  for (const [key, value] of Object.entries(COMPRESSOR)) {
    expect(rendered.params[key], key).toBeCloseTo(value, 5);
  }
  expect(rendered.peak).toBeLessThanOrEqual(1);
  const drop = 20 * Math.log10(rendered.loud / rendered.quiet);
  expect(rendered.trackGain).toBe(1);
  // The source swings 32.6 dB; the compressor must bring that under 20 dB.
  expect(drop).toBeGreaterThan(0);
  expect(drop).toBeLessThanOrEqual(20);

  await expectLevelingText(page, '全链');
});

test('a cross-origin stream plays natively and reports that levelling is unsupported', async ({
  page,
}) => {
  await probeAudioGraph(page);
  const mock = await installGraphMock(page, { noDownloadCors: true });
  await startApp(page);
  await connectOneDrive(page, mock);
  await enableLeveling(page);

  // Nothing reached Cache Storage (no CORS on the download host); make sure a
  // leftover entry cannot turn this into the cached branch.
  await page.evaluate(async () => {
    for (const key of await caches.keys()) await caches.delete(key);
  });

  await showFolders(page);
  await page.locator('[data-testid="folder-source-onedrive"]').click();
  await page.locator('[data-testid="track-row"] .track').first().click();
  await expectSource(page, 'download.test');
  await expectPlaying(page);

  expect(await audioCount(page)).toBe(1);
  await expectLevelingText(page, '该来源不支持音量均衡');

  // The first stream play may build a graph and immediately drop it while the
  // element is swapped; every later stream must not build one at all.
  const compressors = await page.evaluate(() => window.__leveling.compressors.length);
  await showFolders(page);
  await page.locator('[data-testid="track-row"] .track').nth(1).click();
  await expectSource(page, 'track-2');
  await expectPlaying(page, { from: 0.05 });
  expect(await audioCount(page)).toBe(1);
  expect(await page.evaluate(() => window.__leveling.compressors.length)).toBe(compressors);
  await expectLevelingText(page, '该来源不支持音量均衡');
});

test('a cached remote track is a blob and gets the full chain', async ({ page }) => {
  await probeAudioGraph(page);
  const mock = await installGraphMock(page, { audio: TAGGED_MP3 });
  await startApp(page);
  await connectOneDrive(page, mock);
  await enableLeveling(page);
  await showFolders(page);

  await page.locator('[data-testid="folder-source-onedrive"]').click();
  await page.locator('[data-testid="track-row"] .track').first().click();
  await expectSource(page, 'blob:');
  await expectPlaying(page);

  await expect
    .poll(() => page.evaluate(() => window.__leveling.gains.at(-1)?.gain.value ?? null), {
      timeout: 10_000,
    })
    .not.toBeNull();
  const value = await page.evaluate(() => window.__leveling.gains.at(-1).gain.value);
  expect(Math.abs(value - TARGET_GAIN)).toBeLessThan(0.005);
  expect(await page.evaluate(() => window.__leveling.compressors.length)).toBe(1);
  await expectLevelingText(page, '全链');
});

test('local → streaming → local keeps one element and keeps playing', async ({ page }) => {
  await probeAudioGraph(page);
  const mock = await installGraphMock(page, { noDownloadCors: true });
  await startApp(page);
  await seedLocalLibrary(page, {
    files: [
      { path: 'Music/tagged.mp3', bytesBase64: TAGGED_MP3.toString('base64'), type: 'audio/mpeg' },
    ],
  });
  await page.reload();
  await connectOneDrive(page, mock);
  await enableLeveling(page);
  await showFolders(page);

  // 1. Local blob: full chain.
  await page.locator('[data-testid="folder-source-local"]').click();
  await page.locator('[data-testid="folder-dir-Music"]').click();
  await page.locator('[data-testid="track-row"] .track').first().click();
  await expectSource(page, 'blob:');
  await expectPlaying(page);
  expect(await audioCount(page)).toBe(1);
  const localGain = await page.evaluate(() => window.__leveling.gains.at(-1)?.gain.value ?? null);
  expect(Math.abs(localGain - TARGET_GAIN)).toBeLessThan(0.005);

  // 2. Streaming remote: the element is replaced, playback stays native.
  await backToSources(page);
  await page.locator('[data-testid="folder-source-onedrive"]').click();
  await page.locator('[data-testid="track-row"] .track').first().click();
  await expectSource(page, 'download.test');
  await expectPlaying(page, { from: 0.05 });
  expect(await audioCount(page)).toBe(1);

  // 3. Back to the local file: a new graph on the new element.
  await backToSources(page);
  await page.locator('[data-testid="folder-source-local"]').click();
  await page.locator('[data-testid="folder-dir-Music"]').click();
  await page.locator('[data-testid="track-row"] .track').first().click();
  await expectSource(page, 'blob:');
  await expectPlaying(page, { from: 0.05 });
  expect(await audioCount(page)).toBe(1);

  const [title, current] = await page.evaluate(() => [
    navigator.mediaSession.metadata?.title ?? null,
    document.querySelector('#songTitle')?.textContent ?? null,
  ]);
  expect(title).toBeTruthy();
  expect(title).toBe(current);
  await expectLevelingText(page, '全链');
});
