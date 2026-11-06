// Build the static app into dist/ (or --out <dir>).
//
// Pipeline: esbuild bundles src/main.js (ESM, minified, content-hashed) and
// src/styles.css into <out>/assets/, src/index.html becomes <out>/index.html
// with its __CSS__ / __JS__ placeholders resolved, static PWA files are copied,
// and src/sw.template.js becomes <out>/sw.js with a build version and precache
// list. The build version is derived from the sources themselves plus an
// optional BUILD_LABEL, so a one-character source change rotates it and the
// same sources always produce the same version.

import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');

const args = process.argv.slice(2);

/** Value of `--name <value>` on the command line, or the fallback. */
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}

const distDir = path.resolve(root, option('--out', 'dist'));

/** Relative URL (for the manifest/SW) of a file inside the output dir. */
function toUrl(file) {
  return './' + path.relative(distDir, file).split(path.sep).join('/');
}

/**
 * Output file of one entry, relative to the output dir. A split build also
 * emits chunks; only entry outputs carry `entryPoint` in the metafile.
 */
function outputOf(result, extension, entry) {
  const wanted = path.resolve(srcDir, entry);
  const files = Object.entries(result.metafile.outputs)
    .filter(
      ([file, meta]) =>
        file.endsWith(extension) &&
        meta.entryPoint &&
        path.resolve(meta.entryPoint) === wanted,
    )
    .map(([file]) => toUrl(path.resolve(root, file)));
  if (files.length !== 1) {
    throw new Error(
      `expected exactly one ${extension} entry output for ${entry}, got ${files.length}: ${files.join(', ')}`,
    );
  }
  return files[0];
}

/** Every JS output (entry + split chunks) as relative URLs, sorted for stable precaching. */
function outputUrls(result, extension) {
  return Object.keys(result.metafile.outputs)
    .filter((file) => file.endsWith(extension))
    .map((file) => toUrl(path.resolve(root, file)))
    .sort();
}

async function bundle(entries, extension, loader = 'js', define = {}) {
  const entryPoints = Object.fromEntries(
    Object.entries(entries).map(([name, file]) => [name, path.join(srcDir, file)]),
  );
  const result = await build({
    entryPoints,
    outdir: distDir,
    entryNames: 'assets/[name]-[hash]',
    chunkNames: 'assets/[name]-[hash]',
    bundle: true,
    minify: true,
    // Only the JS build splits: `import('./t2s-table.js')` becomes a lazy chunk.
    splitting: extension === '.js',
    format: extension === '.js' ? 'esm' : undefined,
    target: 'es2022',
    // Keep CJK table/i18n text as UTF-8 instead of \u escapes: smaller gzip
    // and the lazy table stays greppable in dist/.
    charset: 'utf8',
    legalComments: 'none',
    loader: loader === 'js' ? {} : { [`.${loader}`]: loader },
    define,
    metafile: true,
    logLevel: 'silent',
  });
  const urls = Object.fromEntries(
    Object.keys(entries).map((name) => [name, outputOf(result, extension, entries[name])]),
  );
  return { urls, outputs: outputUrls(result, extension) };
}

/** Version of the build: hash of every source file plus the optional label. */
async function sourceVersion() {
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.push(full);
    }
  }
  await walk(srcDir);

  const relative = (file) => path.relative(srcDir, file).split(path.sep).join('/');
  files.sort((a, b) => {
    const left = relative(a);
    const right = relative(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });

  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(relative(file));
    hash.update(await readFile(file));
  }
  hash.update(process.env.BUILD_LABEL ?? '');
  return hash.digest('hex').slice(0, 10);
}

async function main() {
  const version = await sourceVersion();
  const define = {
    __BUILD_VERSION__: JSON.stringify(version),
  };

  await rm(distDir, { recursive: true, force: true });
  await mkdir(path.join(distDir, 'assets'), { recursive: true });

  // `text.js` reaches `t2s-table.js` only through `import('./t2s-table.js')`,
  // so esbuild emits the table as a lazy chunk, never in the entry bundle.
  const js = await bundle({ main: 'main.js' }, '.js', 'js', define);
  const css = await bundle({ styles: 'styles.css' }, '.css', 'css', define);
  const jsUrl = js.urls.main;
  const cssUrl = css.urls.styles;

  const jsPath = path.join(distDir, jsUrl);
  const cssPath = path.join(distDir, cssUrl);
  const [jsBytes, cssBytes] = await Promise.all([readFile(jsPath), readFile(cssPath)]);

  // Lazy chunks are not referenced from index.html, so they are listed here:
  // every JS output goes into the precache list, not just the entry.
  const chunks = js.outputs.filter((url) => url !== jsUrl);
  const chunkSizes = await Promise.all(
    chunks.map(async (url) => [url, (await readFile(path.join(distDir, url))).length]),
  );

  // Templates are read up front so a broken one fails before esbuild work.
  const template = await readFile(path.join(srcDir, 'index.html'), 'utf8');
  const swTemplate = await readFile(path.join(srcDir, 'sw.template.js'), 'utf8');

  // index.html: resolve placeholders, never ship a template with leftovers.
  for (const placeholder of ['__CSS__', '__JS__']) {
    if (!template.includes(placeholder)) {
      throw new Error(`src/index.html is missing ${placeholder}`);
    }
  }
  const html = template.replace('__CSS__', cssUrl).replace('__JS__', jsUrl);
  if (html.includes('__CSS__') || html.includes('__JS__')) {
    throw new Error('src/index.html still contains an unreplaced placeholder');
  }
  await writeFile(path.join(distDir, 'index.html'), html);

  // Static PWA files.
  await cp(path.join(srcDir, 'manifest.webmanifest'), path.join(distDir, 'manifest.webmanifest'));
  await cp(path.join(srcDir, 'icons'), path.join(distDir, 'icons'), { recursive: true });
  await cp(path.join(srcDir, 'well-known'), path.join(distDir, '.well-known'), { recursive: true });

  const icons = (await readdir(path.join(srcDir, 'icons')))
    .filter((name) => name.endsWith('.png'))
    .sort();
  if (icons.length === 0) throw new Error('no icons found in src/icons/');

  const precache = [
    './',
    './index.html',
    jsUrl,
    ...chunks,
    cssUrl,
    './manifest.webmanifest',
    ...icons.map((name) => `./icons/${name}`),
  ];

  for (const placeholder of ['__VERSION__', '__PRECACHE__']) {
    if (!swTemplate.includes(placeholder)) {
      throw new Error(`src/sw.template.js is missing ${placeholder}`);
    }
  }
  const sw = swTemplate
    .replaceAll('__VERSION__', () => version)
    .replaceAll('__PRECACHE__', () => JSON.stringify(precache));
  if (sw.includes('__VERSION__') || sw.includes('__PRECACHE__')) {
    throw new Error('dist/sw.js still contains an unreplaced placeholder');
  }
  if (!sw.includes(version) || !sw.includes(jsUrl)) {
    throw new Error('dist/sw.js was not generated with this build version/precache');
  }

  // Catch a broken SW template during the build instead of in a browser.
  new vm.Script(sw, { filename: 'sw.js' });

  // Microsoft domain association must ship as valid JSON with our app id.
  const association = JSON.parse(
    await readFile(
      path.join(distDir, '.well-known', 'microsoft-identity-association.json'),
      'utf8',
    ),
  );
  if (
    association?.associatedApplications?.[0]?.applicationId !==
    '195e9ac7-6f9e-4a3c-bf09-42e0961c796a'
  ) {
    throw new Error('dist/.well-known/microsoft-identity-association.json is wrong');
  }
  await writeFile(path.join(distDir, 'sw.js'), sw);

  console.log(`build ok  version=${version}`);
  console.log(`  ${jsUrl}  ${jsBytes.length} B`);
  for (const [url, bytes] of chunkSizes) console.log(`  ${url}  ${bytes} B  (lazy chunk)`);
  console.log(`  ${cssUrl}  ${cssBytes.length} B`);
  console.log(`  precache: ${precache.length} entries`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
