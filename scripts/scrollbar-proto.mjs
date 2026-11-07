// APP-001-BG prototype harness for the settings-pane scrollbar.
//
// Run `npm run build` first, then one of:
//   xvfb-run -a node scripts/scrollbar-proto.mjs      # classic desktop bar
//   PROTO_MODE=overlay node scripts/scrollbar-proto.mjs  # headless overlay bar
//
// The script drives dist/ over a local server, walks the three variants
// (`?scroll=A|B|C`) at 1280x800 and 390x844, and writes screenshots plus
// measured numbers to .scratch/conductor/bg/.
//
// Per variant it answers:
//   * does the content left edge / panel title x move across Settings <-> VIP
//     switches, and how wide does the content box get (bar appearing)?
//   * what the pane's right 40px actually contains, measured from real pixels;
//   * whether the platform painted an overlay bar (reserved width 0, no paint).
//
// Chromium only shows classic, space-reserving bars in headed mode, so the
// canonical screenshots come from `PROTO_MODE=classic` (xvfb). The headless run
// paints overlay bars and is kept as `overlay-*` evidence.

import { chromium, devices, webkit } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, '.scratch', 'conductor', 'bg');
const MODE = process.env.PROTO_MODE === 'overlay' ? 'overlay' : 'classic';
const PREFIX = MODE === 'overlay' ? 'overlay-' : '';
const PORT = Number(process.env.PROTO_PORT ?? (MODE === 'overlay' ? 4176 : 4175));
const BASE = `http://127.0.0.1:${PORT}`;
const VARIANTS = ['A', 'B', 'C', 'D'];
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 390, height: 844 };
const PANE = '.settings-pane:not([hidden]), .vip-pane:not([hidden])';

const shot = (name) => path.join(OUT, `${PREFIX}${name}.png`);

function startServer() {
  const child = spawn(process.execPath, [path.join(root, 'scripts', 'serve.mjs')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('serve.mjs did not start')), 10_000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('serving')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on('exit', (code) => reject(new Error(`serve.mjs exited with ${code}`)));
  });
}

async function openSettings(page, variant) {
  await page.goto(`${BASE}/?scroll=${variant}`);
  await page.locator('.wordmark').waitFor();
  await page.locator('[data-testid="settings-open"]').click();
  await page.locator('[data-testid="source-row-local"]').waitFor();
  // The panel width transition is 0.5s; measure only after it settles.
  await page.waitForTimeout(650);
  const scroll = await page.evaluate((selector) => {
    const pane = document.querySelector(selector);
    return { scrollHeight: pane.scrollHeight, clientHeight: pane.clientHeight };
  }, PANE);
  if (scroll.scrollHeight <= scroll.clientHeight + 20) {
    throw new Error(`settings pane does not scroll at ${page.viewportSize().width}px: ${JSON.stringify(scroll)}`);
  }
}

function measureState(page) {
  return page.evaluate((selector) => {
    const pane = document.querySelector(selector);
    const title = document.getElementById('panelTitle');
    const content = pane.firstElementChild;
    const style = getComputedStyle(pane);
    const bar = getComputedStyle(pane, '::-webkit-scrollbar');
    const thumb = getComputedStyle(pane, '::-webkit-scrollbar-thumb');
    const rect = pane.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    const round = (value) => Number(value.toFixed(2));
    return {
      pane: pane.id,
      contentLeft: round(contentRect.x),
      contentRight: round(contentRect.right),
      contentWidth: round(contentRect.width),
      titleLeft: round(title.getBoundingClientRect().x),
      paneLeft: round(rect.x),
      paneRight: round(rect.right),
      paneWidth: round(rect.width),
      paneHeight: round(rect.height),
      clientWidth: pane.clientWidth,
      reserved: pane.offsetWidth - pane.clientWidth,
      gutter: style.scrollbarGutter,
      barWidth: Number.parseFloat(bar.width) || 0,
      thumbBorder: Number.parseFloat(thumb.borderLeftWidth) || 0,
      thumbClip: thumb.backgroundClip,
      scrollHeight: pane.scrollHeight,
      clientHeight: pane.clientHeight,
      overflowing: pane.scrollHeight > pane.clientHeight,
    };
  }, PANE);
}

/**
 * Decode a PNG in the page (the browser already owns a PNG decoder) and return
 * per-column mean RGB plus per-row "pixels that differ from the dominant
 * colour" counts.
 */
async function analyseStrip(page, buffer) {
  const url = `data:image/png;base64,${buffer.toString('base64')}`;
  return page.evaluate(async (src) => {
    const blob = await (await fetch(src)).blob();
    const img = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, img.width, img.height);
    const at = (x, y) => {
      const i = (y * img.width + x) * 4;
      return [data[i], data[i + 1], data[i + 2]];
    };

    // Dominant colour: the quantised colour covering the most pixels.
    const counts = new Map();
    for (let y = 0; y < img.height; y += 1) {
      for (let x = 0; x < img.width; x += 1) {
        const [r, g, b] = at(x, y);
        const key = `${r >> 3},${g >> 3},${b >> 3}`;
        const entry = counts.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
        entry.n += 1;
        entry.r += r;
        entry.g += g;
        entry.b += b;
        counts.set(key, entry);
      }
    }
    let best = null;
    for (const entry of counts.values()) if (!best || entry.n > best.n) best = entry;
    const bg = [best.r / best.n, best.g / best.n, best.b / best.n].map(Math.round);
    const dist = (r, g, b) => Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]);

    const columns = [];
    for (let x = 0; x < img.width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let y = 0; y < img.height; y += 1) {
        const px = at(x, y);
        r += px[0];
        g += px[1];
        b += px[2];
      }
      columns.push([r / img.height, g / img.height, b / img.height].map(Math.round));
    }

    const rows = [];
    for (let y = 0; y < img.height; y += 1) {
      let painted = 0;
      for (let x = 0; x < img.width; x += 1) {
        const [r, g, b] = at(x, y);
        if (dist(r, g, b) > 24) painted += 1;
      }
      rows.push(painted);
    }
    return { width: img.width, height: img.height, bg, columns, rows };
  }, url);
}

/** Mean colour of each row, limited to the columns [from, to] of the strip. */
async function analyseThumbRows(page, buffer, { from, to }) {
  const url = `data:image/png;base64,${buffer.toString('base64')}`;
  return page.evaluate(
    async ({ src, start, end }) => {
      const blob = await (await fetch(src)).blob();
      const img = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(img.width, img.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, img.width, img.height);
      const means = [];
      for (let y = 0; y < img.height; y += 1) {
        let r = 0;
        let g = 0;
        let b = 0;
        for (let x = start; x <= end; x += 1) {
          const i = (y * img.width + x) * 4;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
        }
        const n = end - start + 1;
        means.push([r / n, g / n, b / n].map(Math.round));
      }
      return means;
    },
    { src: url, start: from, end: to },
  );
}

/** Group adjacent columns whose mean colour stays within `tolerance`. */
function columnRuns(columns, tolerance = 10) {
  const runs = [];
  const close = (a, b) =>
    Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) <= tolerance;
  let start = 0;
  for (let i = 1; i <= columns.length; i += 1) {
    if (i === columns.length || !close(columns[i - 1], columns[i])) {
      runs.push({
        from: start,
        to: i - 1,
        width: i - start,
        rgb: `rgb(${columns[start].join(', ')})`,
      });
      start = i;
    }
  }
  return runs;
}

const rgbOf = (text) => text.match(/\d+/g).map(Number);
const isBackground = (run, bg) => {
  const [r, g, b] = rgbOf(run.rgb);
  return Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]) <= 12;
};

/** The widest painted band (the thumb): width, offsets from the pane edge, colour. */
function paintedBand(strip, runs, dpr) {
  const painted = runs.filter((run) => !isBackground(run, strip.bg));
  if (painted.length === 0) return { cssWidth: 0, cssFromRight: null };
  const widest = painted.reduce((a, b) => (b.width > a.width || (b.width === a.width && b.to > a.to) ? b : a));
  return {
    cssWidth: Number((widest.width / dpr).toFixed(2)),
    thumbStartFromRight: Number(((strip.width - widest.from) / dpr).toFixed(2)),
    thumbEndFromRight: Number(((strip.width - 1 - widest.to) / dpr).toFixed(2)),
    rgb: widest.rgb,
    paintedRuns: painted.map(({ from, to, width, rgb }) => ({
      from: Number((from / dpr).toFixed(2)),
      to: Number((to / dpr).toFixed(2)),
      cssWidth: Number((width / dpr).toFixed(2)),
      rgb,
    })),
  };
}

async function panelSwitch(page, cycles = 3) {
  const states = [{ label: 'settings#0', ...(await measureState(page)) }];
  for (let i = 1; i <= cycles; i += 1) {
    await page.locator('[data-testid="vip-open"]').click();
    await page.waitForTimeout(650);
    states.push({ label: `vip#${i}`, ...(await measureState(page)) });
    await page.locator('[data-testid="settings-open"]').click();
    await page.waitForTimeout(650);
    states.push({ label: `settings#${i}`, ...(await measureState(page)) });
  }
  const base = states[0];
  const shift = (key) =>
    Number(Math.max(...states.map((state) => Math.abs(state[key] - base[key]))).toFixed(2));
  const widths = states.map((state) => state.contentWidth);
  const rights = states.map((state) => state.contentRight);
  const clientWidths = states.map((state) => state.clientWidth);
  return {
    contentLeftShift: shift('contentLeft'),
    titleLeftShift: shift('titleLeft'),
    contentRightShift: shift('contentRight'),
    paneWidthShift: shift('paneWidth'),
    contentWidthRange: [Math.min(...widths), Math.max(...widths)],
    contentRightRange: [Math.min(...rights), Math.max(...rights)],
    clientWidthRange: [Math.min(...clientWidths), Math.max(...clientWidths)],
    reservedByPane: {
      settings: [...new Set(states.filter((s) => s.pane === 'settingsView').map((s) => s.reserved))],
      vip: [...new Set(states.filter((s) => s.pane === 'vipView').map((s) => s.reserved))],
    },
    overflowingByPane: {
      settings: [...new Set(states.filter((s) => s.pane === 'settingsView').map((s) => s.overflowing))],
      vip: [...new Set(states.filter((s) => s.pane === 'vipView').map((s) => s.overflowing))],
    },
    states,
  };
}

async function scrollMiddle(page) {
  await page.evaluate((selector) => {
    const pane = document.querySelector(selector);
    pane.scrollTop = (pane.scrollHeight - pane.clientHeight) / 2;
  }, PANE);
  await page.waitForTimeout(200);
}

async function paneRect(page) {
  return page.evaluate((selector) => {
    const rect = document.querySelector(selector).getBoundingClientRect();
    return { right: rect.right, top: rect.top, height: rect.height };
  }, PANE);
}

async function stripAt(page, y, height) {
  const box = await paneRect(page);
  return page.screenshot({
    clip: { x: box.right - 40, y, width: 40, height },
  });
}

async function runVariant(browser, variant, results) {
  const context = await browser.newContext({
    viewport: DESKTOP,
    deviceScaleFactor: 1,
    locale: 'zh-CN',
  });
  const page = await context.newPage();
  const dpr = 1;
  const entry = {};

  // ---- desktop 1280 ----
  await openSettings(page, variant);
  entry.desktop = await measureState(page);
  await page.screenshot({ path: shot(`${variant}-1280-settings-top`) });

  await scrollMiddle(page);
  await page.screenshot({ path: shot(`${variant}-1280-settings-mid`) });

  const midBox = await paneRect(page);
  const bandBuffer = await stripAt(page, midBox.top + midBox.height / 2 - 20, 40);
  await writeFile(shot(`${variant}-1280-right-edge-band`), bandBuffer);
  const band = await analyseStrip(page, bandBuffer);
  entry.thumb = {
    strip: { cssWidth: band.width / dpr, cssHeight: band.height / dpr },
    stripBg: `rgb(${band.bg.join(', ')})`,
    columns: columnRuns(band.columns).map((run) => ({
      from: run.from / dpr,
      to: run.to / dpr,
      cssWidth: Number((run.width / dpr).toFixed(2)),
      rgb: run.rgb,
    })),
    ...paintedBand(band, columnRuns(band.columns), dpr),
  };

  // Whole-pane strip: proves the thumb's vertical extent at mid-scroll by
  // tracking the thumb columns' colour down the pane.
  const box = await paneRect(page);
  const fullBuffer = await stripAt(page, box.top, box.height);
  await writeFile(shot(`${variant}-1280-right-edge-full`), fullBuffer);
  const thumbColour = entry.thumb.rgb ? rgbOf(entry.thumb.rgb) : null;
  const thumbColumns = thumbColour
    ? entry.thumb.paintedRuns.find(
        (run) => run.cssWidth === entry.thumb.cssWidth && run.rgb === entry.thumb.rgb,
      )
    : null;
  const rowMeans = thumbColumns
    ? await analyseThumbRows(page, fullBuffer, {
        from: Math.round(thumbColumns.from * dpr),
        to: Math.round(thumbColumns.to * dpr),
      })
    : [];
  const matched = rowMeans
    .map((mean, row) => ({ mean, row }))
    .filter(
      ({ mean }) =>
        Math.abs(mean[0] - thumbColour[0]) +
          Math.abs(mean[1] - thumbColour[1]) +
          Math.abs(mean[2] - thumbColour[2]) <=
        24,
    )
    .map(({ row }) => row);
  entry.thumbRows = {
    paneHeight: Number((box.height / dpr).toFixed(2)),
    thumbColumnRange: thumbColumns ? [thumbColumns.from, thumbColumns.to] : null,
    matchedRows: matched.length,
    firstRow: matched.length ? matched[0] : null,
    lastRow: matched.length ? matched[matched.length - 1] : null,
    // Contiguous matched run around the pane's middle: the thumb's painted
    // height at mid-scroll (rounded ends trim a few rows for C).
    midRun: (() => {
      const mid = Math.round(rowMeans.length / 2);
      if (!matched.includes(mid)) return null;
      let start = mid;
      let end = mid;
      while (matched.includes(start - 1)) start -= 1;
      while (matched.includes(end + 1)) end += 1;
      return { from: start, to: end, height: end - start + 1 };
    })(),
  };

  // ---- panel switch stability ----
  entry.switch = await panelSwitch(page);

  // ---- mobile 390 ----
  await page.setViewportSize(MOBILE);
  await page.waitForTimeout(250);
  await openSettings(page, variant);
  entry.mobile = await measureState(page);
  await scrollMiddle(page);
  await page.screenshot({ path: shot(`${variant}-390-settings-mid`) });

  results[variant] = entry;
  await context.close();
}

async function runWebkit() {
  if (process.env.PROTO_WEBKIT === '0') return { skipped: 'PROTO_WEBKIT=0' };
  let browser;
  try {
    browser = await webkit.launch();
  } catch (error) {
    return { skipped: `webkit launch failed: ${error.message.split('\n')[0]}` };
  }
  const out = {};
  try {
    for (const variant of VARIANTS) {
      const context = await browser.newContext({ ...devices['iPhone 13'], locale: 'zh-CN' });
      const page = await context.newPage();
      await openSettings(page, variant);
      await scrollMiddle(page);
      const state = await measureState(page);
      const midBox = await paneRect(page);
      const strip = await stripAt(page, midBox.top + midBox.height / 2 - 20, 40);
      await writeFile(shot(`webkit-iphone-${variant}-right-edge`), strip);
      const analysis = await analyseStrip(page, strip);
      const runs = columnRuns(analysis.columns);
      const scale = analysis.width / 40;
      await page.screenshot({ path: shot(`webkit-iphone-${variant}-mid`) });
      out[variant] = {
        ...state,
        stripDpr: scale,
        stripBg: `rgb(${analysis.bg.join(', ')})`,
        columns: runs.map((run) => ({
          from: Number((run.from / scale).toFixed(2)),
          to: Number((run.to / scale).toFixed(2)),
          cssWidth: Number((run.width / scale).toFixed(2)),
          rgb: run.rgb,
        })),
        painted: paintedBand(analysis, runs, scale),
      };
      await context.close();
    }
  } catch (error) {
    return { error: error.message.split('\n')[0], partial: out };
  } finally {
    await browser.close();
  }
  return out;
}

await mkdir(OUT, { recursive: true });
const server = await startServer();
const results = {
  mode: MODE,
  chromium: MODE === 'overlay' ? 'headless (overlay bars)' : 'headed under xvfb (classic bars)',
  viewport: { desktop: DESKTOP, mobile: MOBILE },
  variants: {},
};
let browser;
try {
  browser = await chromium.launch({ headless: MODE === 'overlay' });
  for (const variant of VARIANTS) await runVariant(browser, variant, results.variants);
  if (MODE === 'classic') results.webkit = await runWebkit();
  else results.webkit = { skipped: 'webkit runs in the classic sweep only' };
} finally {
  await browser?.close();
  server.kill();
  await writeFile(
    path.join(OUT, `measurements-${MODE}.json`),
    `${JSON.stringify(results, null, 2)}\n`,
  );
}

console.log(JSON.stringify(results, null, 2));
