// Enforce the first-load JS budget: gzip every dist/assets/*.js bundle and fail
// above 100 KiB total (level 9 gzip, matching what a server would send).

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

// APP-001-H: i18n tables + settings raise the first-load JS budget to 100 KB gzip.
const LIMIT = 102400;
const assetsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'dist',
  'assets',
);

const files = (await readdir(assetsDir).catch(() => []))
  .filter((name) => name.endsWith('.js'))
  .sort();

if (files.length === 0) {
  console.error(`no JS bundles in ${assetsDir} — run \`npm run build\` first`);
  process.exit(1);
}

const rows = [];
let minTotal = 0;
let gzipTotal = 0;

for (const name of files) {
  const bytes = await readFile(path.join(assetsDir, name));
  const gzip = gzipSync(bytes, { level: 9 }).length;
  minTotal += bytes.length;
  gzipTotal += gzip;
  rows.push({ name: `assets/${name}`, min: bytes.length, gzip });
}

const width = Math.max(...rows.map((row) => row.name.length), 'total'.length);
const number = (value) => String(value).padStart(10);

console.log(`${'file'.padEnd(width)}  ${'min'.padStart(10)}  ${'gzip'.padStart(10)}`);
for (const row of rows) {
  console.log(`${row.name.padEnd(width)}  ${number(row.min)}  ${number(row.gzip)}`);
}
console.log(
  `${'total'.padEnd(width)}  ${number(minTotal)}  ${number(gzipTotal)}  (limit ${LIMIT} gzip)`,
);

if (gzipTotal > LIMIT) {
  console.error(`JS budget exceeded: ${gzipTotal} > ${LIMIT} bytes gzip`);
  process.exit(1);
}
