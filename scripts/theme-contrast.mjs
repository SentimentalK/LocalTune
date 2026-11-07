// WCAG contrast audit for every colour theme in src/styles.css.
//
// The themes are plain CSS overrides, so this reads the sheet instead of a
// second token table: `:root` holds the defaults, each
// `:root[data-theme="name"]` block may override any of them. The chalk ink is
// read from chalkLayer.js because the notes are drawn in JS, not CSS.
//
// Floor per token (all measured against the theme's own --bg unless noted):
//   --text 7:1 · --dim 4.5:1 · --muted 3:1 · --accent 3:1 (non-text)
//   --warn 3:1 · --danger 3:1 · chalk ink 4.5:1 on --bg and on --bg2
//
// Run directly (`npm run theme:check`) to print the table; tests import it.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const MINIMUM = {
  text: 7,
  dim: 4.5,
  muted: 3,
  accent: 3,
  warn: 3,
  danger: 3,
  ink_bg: 4.5,
  ink_bg2: 4.5,
};

/** `--name: value;` pairs inside one CSS block, trimmed. */
function declarations(body) {
  const values = {};
  for (const match of body.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    values[match[1]] = match[2].trim();
  }
  return values;
}

/** All `:root` and `:root[data-theme="…"]` blocks, in source order. */
export function parseThemes(css) {
  const themes = new Map();
  let base = {};
  const rule = /:root(\[data-theme="([a-z-]+)"\])?\s*\{([^}]*)\}/g;
  for (const match of css.matchAll(rule)) {
    const [, , name, body] = match;
    const values = declarations(body);
    if (!name) {
      base = { ...base, ...values };
      continue;
    }
    themes.set(name, { ...(themes.get(name) ?? {}), ...values });
  }
  return { base, themes };
}

/** Chalk ink hex from `chalkLayer.js` (`const INK = '#F2F5F3';`). */
export function parseInk(source) {
  const match = source.match(/const\s+INK\s*=\s*'([^']+)'/);
  if (!match) throw new Error('chalkLayer.js: INK constant not found');
  return match[1];
}

function channels(hex) {
  const value = hex.replace('#', '');
  const full =
    value.length === 3
      ? value
          .split('')
          .map((part) => part + part)
          .join('')
      : value;
  if (!/^[0-9a-f]{6}$/i.test(full)) throw new Error(`not a hex colour: ${hex}`);
  return [0, 2, 4].map((index) => parseInt(full.slice(index, index + 2), 16));
}

function linear(channel) {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex) {
  const [r, g, b] = channels(hex).map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio between two opaque hex colours. */
export function contrast(a, b) {
  const first = luminance(a);
  const second = luminance(b);
  const [hi, lo] = first < second ? [second, first] : [first, second];
  return (hi + 0.05) / (lo + 0.05);
}

/** Contrast of every audited token pair for each theme, defaults merged in. */
export function audit({ base, themes }, ink, defaultTheme) {
  const rows = [];
  const merged = new Map([[defaultTheme, {}], ...themes]);
  for (const [name, overrides] of merged) {
    const values = { ...base, ...overrides };
    const bg = values.bg;
    const bg2 = values.bg2 ?? bg;
    const ratios = {
      text: contrast(values.text, bg),
      dim: contrast(values.dim, bg),
      muted: contrast(values.muted, bg),
      accent: contrast(values.accent, bg),
      warn: contrast(values.warn, bg),
      danger: contrast(values.danger, bg),
      ink_bg: contrast(ink, bg),
      ink_bg2: contrast(ink, bg2),
    };
    const failures = Object.entries(ratios)
      .filter(([key, ratio]) => ratio < MINIMUM[key])
      .map(([key, ratio]) => `${key} ${ratio.toFixed(2)} < ${MINIMUM[key]}`);
    rows.push({ name, bg, bg2, accent: values.accent, ratios, failures });
  }
  return rows;
}

export async function loadAudit() {
  const [css, chalk, { DEFAULT_THEME }] = await Promise.all([
    readFile(path.join(root, 'src/styles.css'), 'utf8'),
    readFile(path.join(root, 'src/ui/chalkLayer.js'), 'utf8'),
    import('../src/ui/uiPrefs.js'),
  ]);
  return audit(parseThemes(css), parseInk(chalk), DEFAULT_THEME);
}

if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  const rows = await loadAudit();
  const keys = Object.keys(MINIMUM);
  console.log(['theme'.padEnd(10), 'bg'.padEnd(8), 'accent'.padEnd(8), ...keys.map((key) => key.padStart(9))].join(' '));
  let failed = 0;
  for (const row of rows) {
    console.log(
      [
        row.name.padEnd(10),
        row.bg.padEnd(8),
        row.accent.padEnd(8),
        ...keys.map((key) => row.ratios[key].toFixed(2).padStart(9)),
      ].join(' '),
    );
    if (row.failures.length > 0) {
      failed += 1;
      console.error(`  ✗ ${row.name}: ${row.failures.join('; ')}`);
    }
  }
  console.log(`\n${rows.length - failed}/${rows.length} themes pass.`);
  process.exit(failed === 0 ? 0 : 1);
}
