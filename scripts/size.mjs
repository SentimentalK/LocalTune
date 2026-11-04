// Enforce the first-load JS budget: gzip the scripts `dist/index.html` actually
// loads (the esbuild entry, which already inlines its static imports) and fail
// above 100 KiB total (level 9 gzip, matching what a server would send).
// Lazy chunks are printed but never counted: they load on demand.

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

// APP-001-H: i18n tables + settings raise the first-load JS budget to 100 KB gzip.
const LIMIT = 102400;
const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const assetsDir = path.join(distDir, 'assets');

const html = await readFile(path.join(distDir, 'index.html'), 'utf8').catch(() => null);
if (html === null) {
  console.error(`no dist/index.html in ${distDir} — run \`npm run build\` first`);
  process.exit(1);
}

/** Script URLs referenced by index.html, as paths relative to dist/. */
const entryFiles = [];
for (const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)) {
  const url = match[1] ?? match[2];
  if (!url.endsWith('.js')) continue;
  const relative = url.replace(/^\.?\//, '').split(/[?#]/)[0];
  if (!entryFiles.includes(relative)) entryFiles.push(relative);
}

if (entryFiles.length === 0) {
  console.error('dist/index.html references no JS scripts — run `npm run build` first');
  process.exit(1);
}

const allJs = (await readdir(assetsDir).catch(() => []))
  .filter((name) => name.endsWith('.js'))
  .map((name) => `assets/${name}`)
  .sort();
const chunkFiles = allJs.filter((name) => !entryFiles.includes(name));

/** Gzip size of one dist-relative file plus its minified size. */
async function measure(name) {
  const bytes = await readFile(path.join(distDir, name)).catch(() => null);
  if (!bytes) {
    console.error(`missing ${name} referenced by index.html — run \`npm run build\` first`);
    process.exit(1);
  }
  return { name, min: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length };
}

const rows = await Promise.all(entryFiles.map(measure));
const chunks = await Promise.all(chunkFiles.map(measure));

const width = Math.max(...[...rows, ...chunks].map((row) => row.name.length), 'total'.length);
const number = (value) => String(value).padStart(10);

const minTotal = rows.reduce((sum, row) => sum + row.min, 0);
const gzipTotal = rows.reduce((sum, row) => sum + row.gzip, 0);

console.log(`${'file'.padEnd(width)}  ${'min'.padStart(10)}  ${'gzip'.padStart(10)}`);
for (const row of rows) {
  console.log(`${row.name.padEnd(width)}  ${number(row.min)}  ${number(row.gzip)}`);
}
console.log(
  `${'total'.padEnd(width)}  ${number(minTotal)}  ${number(gzipTotal)}  (limit ${LIMIT} gzip)`,
);
for (const row of chunks) {
  console.log(`chunk: ${row.name}  ${row.min} B min  ${row.gzip} B gzip (not counted)`);
}

if (gzipTotal > LIMIT) {
  console.error(`JS budget exceeded: ${gzipTotal} > ${LIMIT} bytes gzip`);
  process.exit(1);
}
