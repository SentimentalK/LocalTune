/**
 * Memory probe: measures the running app's memory at process level (APP-001-AA).
 *
 * Read-only: it never mutates source, only a throwaway Chromium profile under
 * .scratch/memory-probe/ (gitignored).
 *
 * Scenarios
 *   empty   : empty library, demo dismissed (meta demoDismissed=true, no tracks)
 *   demo    : default first launch (3 demo tracks in the queue)
 *   lib1000 : 1000 synthetic tracks with cover blobs in IndexedDB
 *
 * Usage
 *   node scripts/memory-probe.mjs --label empty-local --url http://127.0.0.1:4173/ \
 *        --scenario empty --samples 5,30,60 [--variant baseline|no-filter|...]
 *        [--headless] [--dpr 1] [--keep] [--cache-bytes]
 *
 * Output: JSON per run in .scratch/memory-probe/runs/<label>.json plus a
 * one-line summary on stdout. Process numbers come from /proc (RSS, PSS,
 * private clean+dirty = Chrome Task Manager "memory footprint" analogue).
 *
 * PSS apportions shared pages across every process mapping them, so only
 * compare PSS between runs started with the same number of live Chromium
 * instances. Private footprint has no such coupling: prefer it.
 */

import { chromium } from 'playwright';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const outDir = path.join(root, '.scratch', 'memory-probe');
const runsDir = path.join(outDir, 'runs');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = args[i + 1];
  return value && !value.startsWith('--') ? value : true;
};
const has = (name) => args.includes(`--${name}`);

const label = option('label', 'run');
const url = option('url', 'http://127.0.0.1:4173/');
const scenario = option('scenario', 'empty');
const variant = option('variant', 'baseline');
const samples = String(option('samples', '5,30,60'))
  .split(',')
  .map((n) => Number(n))
  .filter((n) => Number.isFinite(n))
  .sort((a, b) => a - b);
const headless = has('headless');
const dpr = Number(option('dpr', '1'));
const keep = has('keep');
const openLibrary = has('open-library');
const searchQueryFlag = option('search', null);
const play = has('play');
const coverBytes = Number(option('cover-bytes', '0'));
const cacheBytes = has('cache-bytes');
const width = Number(option('width', '1440'));
const height = Number(option('height', '900'));

const profileDir = path.join(outDir, 'profiles', label);

/** CSS / JS overrides that isolate one suspect at a time. */
const VARIANTS = {
  baseline: {},
  'no-svg-filter': {
    css: `.tonearm-motion, .stylus-point, .arm-handle:focus-visible { filter: none !important; }`,
  },
  'no-blur': {
    css: `.deck::before, .reflection { filter: none !important; }`,
  },
  'no-backdrop': {
    css: `* { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }`,
  },
  'no-mask-blend': {
    css: `.vinyl::before, .vinyl::after, .reflection, .reflection::after { -webkit-mask-image: none !important; mask-image: none !important; mix-blend-mode: normal !important; }`,
  },
  'no-raf': {
    js: `window.requestAnimationFrame = () => 0;`,
  },
  'no-sw': {},
  'cv-auto': { css: `.track-item, .track { content-visibility: auto; contain-intrinsic-size: auto 56px; }` },
  'no-heavy-effects': {
    css: `*, *::before, *::after { filter: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; mix-blend-mode: normal !important; -webkit-mask-image: none !important; mask-image: none !important; box-shadow: none !important; will-change: auto !important; animation: none !important; }`,
  },
  'no-gpu': {},
  'no-css-at-all': { css: `html { all: unset; }` },
};

async function readProcFile(pid, name) {
  try {
    return await readFile(`/proc/${pid}/${name}`, 'utf8');
  } catch {
    return null;
  }
}

function memoryFromStatus(status) {
  const out = {};
  for (const line of status.split('\n')) {
    const m = /^(VmRSS|VmHWM|VmSize):\s+(\d+) kB/.exec(line);
    if (m) out[m[1]] = Number(m[2]) * 1024;
  }
  return out;
}

function memoryFromSmapsRollup(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^(Rss|Pss|Pss_Anon|Pss_File|Private_Clean|Private_Dirty|Shared_Clean|Shared_Dirty|Swap):\s+(\d+) kB/.exec(
      line,
    );
    if (m) out[m[1]] = Number(m[2]) * 1024;
  }
  return out;
}

/** Every Chromium process whose cmdline carries our profile dir. */
async function chromeProcesses() {
  const entries = await readdir('/proc');
  const rows = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const cmdline = await readProcFile(entry, 'cmdline');
    if (!cmdline || !cmdline.includes(profileDir)) continue;
    // /proc/<pid>/cmdline separates argv with NUL bytes; regex avoids relying
    // on the shell round-trip of a split('\0').
    const typeMatch = /--type=([a-z-]+)/.exec(cmdline);
    let type = typeMatch ? typeMatch[1] : 'browser';
    if (type === 'utility') {
      const sub = /--utility-sub-type=([A-Za-z0-9_.]+)/.exec(cmdline);
      if (sub) type = `utility:${sub[1].split('.').pop()}`;
    }
    if (type === 'renderer') {
      if (cmdline.includes('--service-worker')) type = 'renderer:service-worker';
      else if (cmdline.includes('--top-chrome-webui')) type = 'renderer:webui';
    }
    const status = await readProcFile(entry, 'status');
    const rollup = await readProcFile(entry, 'smaps_rollup');
    rows.push({
      pid: Number(entry),
      type,
      ...(status ? memoryFromStatus(status) : {}),
      ...(rollup ? memoryFromSmapsRollup(rollup) : {}),
    });
  }
  return rows;
}

function sumBy(rows, key) {
  return rows.reduce((sum, row) => sum + (row[key] ?? 0), 0);
}

function group(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.type.startsWith('utility:') ? 'utility' : row.type;
    const acc = groups.get(key) ?? { type: key, count: 0, rss: 0, pss: 0, footprint: 0 };
    acc.count += 1;
    acc.rss += row.VmRSS ?? 0;
    acc.pss += row.Pss ?? 0;
    acc.footprint += (row.Private_Clean ?? 0) + (row.Private_Dirty ?? 0) + (row.Swap ?? 0);
    groups.set(key, acc);
  }
  return [...groups.values()].sort((a, b) => b.pss - a.pss);
}

const subject = (percent) =>
  percent > 0 ? Math.round(percent * 100) : 0;

async function samplePage(page) {
  const cdp = page.__cdp;
  const metrics = await cdp.send('Performance.getMetrics').catch(() => ({ metrics: [] }));
  const map = Object.fromEntries(metrics.metrics.map((m) => [m.name, m.value]));
  const dom = await cdp.send('Memory.getDOMCounters').catch(() => ({}));
  const extra = await page
    .evaluate(() => {
      const counters = window.__objUrls ?? { created: 0, revoked: 0, live: 0 };
      const images = [...document.querySelectorAll('img')];
      const blobImages = images.filter((img) => img.src.startsWith('blob:')).length;
      const perf = performance.memory
        ? {
            usedJSHeapSize: performance.memory.usedJSHeapSize,
            totalJSHeapSize: performance.memory.totalJSHeapSize,
            jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
          }
        : null;
      return {
        counters,
        elements: document.getElementsByTagName('*').length,
        images: images.length,
        blobImages,
        perf,
      };
    })
    .catch(() => ({}));
  const caches = await page
    .evaluate(async (wantBytes) => {
      const out = [];
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        const requests = await cache.keys();
        let bytes = 0;
        if (wantBytes) {
          for (const request of requests) {
            const response = await cache.match(request);
            if (!response) continue;
            try {
              const blob = await response.clone().blob();
              bytes += blob.size;
            } catch {
              // ignore unreadable entries
            }
          }
        }
        out.push({ name, entries: requests.length, bytes });
      }
      return out;
    }, cacheBytes)
    .catch(() => []);

  return {
    ts: Date.now(),
    jsHeapUsed: map.JSHeapUsedSize ?? null,
    jsHeapTotal: map.JSHeapTotalSize ?? null,
    jsHeapLimit: map.JSHeapSizeLimit ?? null,
    embedderHeapUsed: map.EmbedderHeapUsedSize ?? null,
    backingStorage: map.BackingStorageSize ?? null,
    arrayBuffer: map.ArrayBufferContents ?? null,
    nodes: dom.nodes ?? map.Nodes ?? null,
    documents: dom.documents ?? map.Documents ?? null,
    listeners: map.JSEventListeners ?? null,
    layoutCount: map.LayoutCount ?? null,
    recalcStyleCount: map.RecalcStyleCount ?? null,
    taskDuration: map.TaskDuration ?? null,
    scriptDuration: map.ScriptDuration ?? null,
    elements: extra.elements ?? null,
    images: extra.images ?? null,
    blobImages: extra.blobImages ?? null,
    objectUrls: extra.counters ?? null,
    perf: extra.perf ?? null,
    caches,
  };
}

async function sampleProcesses() {
  const rows = await chromeProcesses();
  return {
    rows,
    totals: {
      rss: sumBy(rows, 'VmRSS'),
      pss: sumBy(rows, 'Pss'),
      footprint: rows.reduce(
        (sum, row) => sum + (row.Private_Clean ?? 0) + (row.Private_Dirty ?? 0) + (row.Swap ?? 0),
        0,
      ),
      processes: rows.length,
    },
    groups: group(rows),
  };
}

const mb = (bytes) => Math.round(((bytes ?? 0) / 1048576) * 10) / 10;

async function main() {
  await mkdir(runsDir, { recursive: true });
  if (!keep) await rm(profileDir, { recursive: true, force: true });
  await mkdir(profileDir, { recursive: true });

  const launchArgs = [
    '--enable-gpu-benchmarking',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
  ];
  if (variant === 'no-sw') launchArgs.push('--disable-features=ServiceWorker');
  if (variant === 'no-gpu') launchArgs.push('--disable-gpu', '--disable-gpu-compositing');
  if (variant === 'swiftshader') launchArgs.push('--disable-gpu', '--enable-unsafe-swiftshader', '--use-angle=swiftshader');

  const context = await chromium.launchPersistentContext(profileDir, {
    headless,
    viewport: { width, height },
    deviceScaleFactor: dpr,
    args: launchArgs,
    locale: 'en-US',
  });

  await context.addInitScript(() => {
    const counters = { created: 0, revoked: 0, live: 0 };
    window.__objUrls = counters;
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      counters.created += 1;
      counters.live += 1;
      return create(blob);
    };
    URL.revokeObjectURL = (url) => {
      counters.revoked += 1;
      counters.live -= 1;
      return revoke(url);
    };
  });

  const page = context.pages()[0] ?? (await context.newPage());
  page.__cdp = await context.newCDPSession(page);
  await page.__cdp.send('Performance.enable').catch(() => {});

  const requests = [];
  page.on('response', async (response) => {
    try {
      const sizes = await response.request().sizes();
      requests.push({
        url: response.url().slice(0, 160),
        status: response.status(),
        body: sizes.responseBodySize,
        type: response.request().resourceType(),
      });
    } catch {
      // sizes unavailable for aborted requests
    }
  });

  // --- scenario seeding -------------------------------------------------
  const seed = async () => {
    if (scenario === 'empty') {
      await page.evaluate(async () => {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open('localtune');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        await new Promise((resolve, reject) => {
          const tx = db.transaction(['tracks', 'meta'], 'readwrite');
          tx.objectStore('tracks').clear();
          tx.objectStore('meta').put({ key: 'demoDismissed', value: true });
          tx.objectStore('meta').delete('playback');
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        db.close();
      });
    }
    if (scenario === 'lib1000') {
      await page.evaluate(async (COVER_BYTES) => {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open('localtune');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const fetched = new Uint8Array(
          await (await fetch('./icons/icon-512.png')).arrayBuffer(),
        );
        const wanted = Number(COVER_BYTES) || fetched.length;
        const bytes = new Uint8Array(wanted);
        bytes.set(fetched.subarray(0, Math.min(wanted, fetched.length)));
        if (wanted > fetched.length) {
          // Deterministic filler after the PNG IEND chunk: decoders ignore it,
          // Blob storage still counts the bytes.
          for (let i = fetched.length; i < wanted; i += 1) bytes[i] = i & 0xff;
        }
        await new Promise((resolve, reject) => {
          const tx = db.transaction(['tracks', 'meta'], 'readwrite');
          const tracks = tx.objectStore('tracks');
          tracks.clear();
          for (let i = 0; i < 1000; i += 1) {
            tracks.put({
              id: `synth-${i}`,
              title: `Synthetic track ${i}`,
              artist: `Artist ${i % 40}`,
              album: `Album ${i % 80}`,
              duration: 180 + (i % 120),
              cover: new Blob([bytes], { type: 'image/png' }),
              path: `synthetic/${i}.mp3`,
              source: 'local',
            });
          }
          tx.objectStore('meta').put({ key: 'demoDismissed', value: true });
          tx.objectStore('meta').delete('playback');
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        db.close();
      }, coverBytes);
    }
  };

  const waitReady = async () => {
    await page.waitForFunction(() => Boolean(document.getElementById('armRotor')), null, {
      timeout: 30000,
    });
    await page.waitForTimeout(500);
  };

  const t0 = Date.now();
  if (scenario === 'blank') {
    await page.goto('about:blank', { waitUntil: 'load' });
  } else {
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    await waitReady();
    if (scenario !== 'demo') {
      await seed();
      await page.reload({ waitUntil: 'load' });
      await waitReady();
    }
  }

  const spec = VARIANTS[variant] ?? {};
  if (spec.css) await page.addStyleTag({ content: spec.css });
  if (spec.js) await page.addScriptTag({ content: spec.js });

  if (play && scenario !== 'blank') {
    await page.locator('.arm-head-hit').click({ force: true }).catch(() => {});
    await page.waitForTimeout(500);
  }
  if (searchQueryFlag && scenario !== 'blank') {
    await page.fill('[data-testid="search-input"]', String(searchQueryFlag));
    await page.waitForSelector('[data-testid="track-row"]', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
  if (openLibrary && scenario !== 'blank') {
    await page.click('[data-testid="panel-open"]');
    await page
      .waitForSelector('[data-testid="track-row"]', { timeout: 15000 })
      .catch(() => {});
    await page.waitForTimeout(1500);
  }

  // --- sampling ---------------------------------------------------------
  const snapshots = [];
  const started = Date.now();
  snapshots.push({
    at: 0,
    page: await samplePage(page),
    processes: await sampleProcesses(),
  });
  for (const second of samples) {
    const wait = second * 1000 - (Date.now() - started);
    if (wait > 0) await page.waitForTimeout(wait);
    snapshots.push({
      at: Math.round((Date.now() - started) / 1000),
      page: await samplePage(page),
      processes: await sampleProcesses(),
    });
  }

  // --- GPU / software compositing evidence ------------------------------
  const gpu = await page.__cdp
    .send('SystemInfo.getInfo')
    .then((info) => ({
      devices: info.gpu?.devices?.map((d) => ({
        vendor: d.vendorString,
        device: d.deviceString,
        vendorId: d.vendorId,
        deviceId: d.deviceId,
      })),
      aux: info.gpu?.auxAttributes ?? info.gpu?.featureStatus ? { featureStatus: info.gpu?.featureStatus } : null,
    }))
    .catch((error) => ({ error: String(error).slice(0, 200) }));

  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 300)));

  const result = {
    label,
    url,
    scenario,
    variant,
    headless,
    dpr,
    viewport: { width, height },
    t0: new Date(t0).toISOString(),
    loadMs: Date.now() - t0,
    snapshots,
    requests: requests.sort((a, b) => b.body - a.body).slice(0, 25),
    requestTotals: {
      count: requests.length,
      bytes: requests.reduce((sum, row) => sum + (row.body > 0 ? row.body : 0), 0),
    },
    gpu,
    pageErrors,
    ua: await page.evaluate(() => navigator.userAgent),
    webgl: await page
      .evaluate(() => {
        try {
          const canvas = document.createElement('canvas');
          const gl = canvas.getContext('webgl');
          if (!gl) return null;
          const ext = gl.getExtension('WEBGL_debug_renderer_info');
          return {
            vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
            renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
          };
        } catch {
          return null;
        }
      })
      .catch(() => null),
  };

  await writeFile(path.join(runsDir, `${label}.json`), JSON.stringify(result, null, 2));

  const last = snapshots[snapshots.length - 1];
  const first = snapshots[0];
  console.log(
    [
      `${label}`.padEnd(28),
      `pss=${mb(last.processes.totals.pss)}MB`,
      `(t0 ${mb(first.processes.totals.pss)}MB)`,
      `fp=${mb(last.processes.totals.footprint)}MB`,
      `jsHeap=${mb(last.page.jsHeapUsed)}MB`,
      `nodes=${last.page.nodes}`,
      `listeners=${last.page.listeners}`,
      `objURL=${last.page.objectUrls?.live ?? '?'}`,
      `procs=${last.processes.totals.processes}`,
      `groups=${last.processes.groups.map((g) => `${g.type}:${mb(g.pss)}`).join(',')}`,
    ].join(' '),
  );

  await context.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
