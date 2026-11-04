// Build the static app into dist/.
//
// Pipeline: esbuild bundles src/main.js (ESM, minified, content-hashed) and
// src/styles.css into dist/assets/, src/index.html becomes dist/index.html with
// its __CSS__ / __JS__ placeholders resolved, static PWA files are copied, and
// src/sw.template.js becomes dist/sw.js with a build version and precache list.

import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');
const distDir = path.join(root, 'dist');

/** Relative URL (for the manifest/SW) of a file inside dist/. */
function toUrl(file) {
  return './' + path.relative(distDir, file).split(path.sep).join('/');
}

/** Output file of an esbuild build, relative to dist/. */
function outputOf(result, extension) {
  const files = Object.keys(result.metafile.outputs).filter((file) =>
    file.endsWith(extension),
  );
  if (files.length !== 1) {
    throw new Error(
      `expected exactly one ${extension} output, got ${files.length}: ${files.join(', ')}`,
    );
  }
  return toUrl(path.resolve(root, files[0]));
}

async function bundle(entry, extension, loader = 'js') {
  const result = await build({
    entryPoints: { [path.basename(entry, path.extname(entry))]: path.join(srcDir, entry) },
    outdir: distDir,
    entryNames: 'assets/[name]-[hash]',
    bundle: true,
    minify: true,
    format: extension === '.js' ? 'esm' : undefined,
    target: 'es2022',
    legalComments: 'none',
    loader: loader === 'js' ? {} : { [`.${loader}`]: loader },
    metafile: true,
    logLevel: 'silent',
  });
  return outputOf(result, extension);
}

async function main() {
  await rm(distDir, { recursive: true, force: true });
  await mkdir(path.join(distDir, 'assets'), { recursive: true });

  const jsUrl = await bundle('main.js', '.js');
  const cssUrl = await bundle('styles.css', '.css', 'css');

  const jsPath = path.join(distDir, jsUrl);
  const cssPath = path.join(distDir, cssUrl);
  const [jsBytes, cssBytes] = await Promise.all([readFile(jsPath), readFile(cssPath)]);

  // Read templates up front: the SW source is part of the version so changing
  // only SW logic still rotates the cache name.
  const template = await readFile(path.join(srcDir, 'index.html'), 'utf8');
  const swTemplate = await readFile(path.join(srcDir, 'sw.template.js'), 'utf8');

  const version = createHash('sha256')
    .update(jsBytes)
    .update(cssBytes)
    .update(swTemplate)
    .digest('hex')
    .slice(0, 10);

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

  const icons = (await readdir(path.join(srcDir, 'icons')))
    .filter((name) => name.endsWith('.png'))
    .sort();
  if (icons.length === 0) throw new Error('no icons found in src/icons/');

  const precache = [
    './',
    './index.html',
    jsUrl,
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
  await writeFile(path.join(distDir, 'sw.js'), sw);

  console.log(`build ok  version=${version}`);
  console.log(`  ${jsUrl}  ${jsBytes.length} B`);
  console.log(`  ${cssUrl}  ${cssBytes.length} B`);
  console.log(`  precache: ${precache.length} entries`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
