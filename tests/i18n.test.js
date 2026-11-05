import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LOCALES,
  LOCALE_LABELS,
  ensureLocale,
  getLocale,
  hasLocale,
  localeLabel,
  resolveLanguage,
  resolveLocale,
  setLocale,
  systemLocale,
  t,
} from '../src/i18n/index.js';
import en from '../src/i18n/en.js';

// The runtime only loads chunks on demand, so the tests load every table up
// front. `TABLES` here is test-local: importing a file does not register it.
const TABLES = { en };
for (const locale of LOCALES) {
  if (locale !== 'en') TABLES[locale] = (await import(`../src/i18n/${locale}.js`)).default;
}

const placeholders = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

after(() => {
  setLocale('en');
});

test('resolveLocale maps the browser language list in order', () => {
  const cases = [
    [['ko-KR'], 'ko'],
    [['es-419'], 'es'],
    [['fr-CA'], 'fr'],
    [['de-AT'], 'de'],
    [['pt-BR'], 'pt-BR'],
    [['pt-PT'], 'pt-BR'],
    [['ru-RU'], 'ru'],
    [['zh-Hant-TW'], 'zh-TW'],
    [['zh-HK'], 'zh-TW'],
    [['zh-TW'], 'zh-TW'],
    [['zh-SG'], 'zh-CN'],
    [['zh-CN'], 'zh-CN'],
    [['zh'], 'zh-CN'],
    [['ja-JP'], 'ja'],
    [['en-US'], 'en'],
    [['sw-KE'], 'en'],
    [['sw-KE', 'ko-KR'], 'ko'],
    [['fr-FR', 'ja-JP'], 'fr'],
    [[''], 'en'],
    [[], 'en'],
    [undefined, 'en'],
  ];
  for (const [languages, expected] of cases) {
    assert.equal(resolveLocale(languages), expected, JSON.stringify(languages));
  }
});

test('resolveLanguage prefers an explicit supported setting', () => {
  assert.equal(resolveLanguage('auto', ['ja-JP']), 'ja');
  assert.equal(resolveLanguage('zh-TW', ['en-US']), 'zh-TW');
  assert.equal(resolveLanguage('ja', ['zh-CN']), 'ja');
  assert.equal(resolveLanguage('ko', ['en-US']), 'ko');
  assert.equal(resolveLanguage('pt-BR', ['en-US']), 'pt-BR');
  assert.equal(resolveLanguage('klingon', ['ja-JP']), 'ja');
  assert.equal(resolveLanguage(null, ['zh-TW']), 'zh-TW');
});

test('every locale defines exactly the same keys and non-empty strings', () => {
  const expected = Object.keys(en).sort();
  for (const locale of LOCALES) {
    const table = TABLES[locale];
    assert.deepEqual(Object.keys(table).sort(), expected, locale);
    for (const key of expected) {
      const value = table[key];
      assert.equal(typeof value, 'string', `${locale} ${key} is a string`);
      assert.ok(value.trim().length > 0, `${locale} ${key} is non-empty`);
      assert.notEqual(value, key, `${locale} ${key} is not the key itself`);
    }
  }
});

test('every translation keeps the same placeholder set as English', () => {
  for (const locale of LOCALES) {
    for (const key of Object.keys(en)) {
      assert.deepEqual(
        placeholders(TABLES[locale][key]),
        placeholders(en[key]),
        `${locale} ${key}`,
      );
    }
  }
});

test('the six new tables are actually translated, not copied from English', () => {
  const samples = [
    'tabs.folders',
    'common.loading',
    'settings.language.title',
    'settings.language.auto',
  ];
  for (const locale of ['ko', 'es', 'fr', 'de', 'pt-BR', 'ru']) {
    for (const key of samples) {
      assert.notEqual(TABLES[locale][key], en[key], `${locale} ${key}`);
    }
  }
});

test('localeLabel names every locale and falls back to English', () => {
  const expected = {
    en: 'English',
    'zh-CN': '简体中文',
    'zh-TW': '繁體中文',
    ja: '日本語',
    ko: '한국어',
    es: 'Español',
    fr: 'Français',
    de: 'Deutsch',
    'pt-BR': 'Português (Brasil)',
    ru: 'Русский',
  };
  assert.deepEqual(Object.keys(LOCALE_LABELS).sort(), Object.keys(expected).sort());
  for (const [locale, label] of Object.entries(expected)) {
    assert.equal(localeLabel(locale), label, locale);
  }
  assert.equal(localeLabel('xx'), 'English');
});

test('systemLocale resolves once and reports the display label', () => {
  assert.deepEqual(systemLocale(['fr-FR']), { locale: 'fr', label: 'Français' });
  assert.deepEqual(systemLocale(['pt-PT']), { locale: 'pt-BR', label: 'Português (Brasil)' });
  assert.deepEqual(systemLocale([]), { locale: 'en', label: 'English' });
});

test('ensureLocale loads a chunk once and setLocale only accepts loaded tables', async () => {
  assert.equal(await ensureLocale('ko'), 'ko');
  assert.equal(hasLocale('ko'), true);
  setLocale('ko');
  assert.equal(getLocale(), 'ko');
  assert.equal(t('tabs.folders'), TABLES.ko['tabs.folders']);
  assert.equal(await ensureLocale('ko'), 'ko');

  assert.equal(await ensureLocale('en'), 'en');
  assert.equal(await ensureLocale('xx'), 'en');
  setLocale('xx');
  assert.equal(getLocale(), 'ko');
});

test('hasLocale tracks the lazy tables', async () => {
  assert.equal(hasLocale('ru'), false);
  assert.equal(await ensureLocale('ru'), 'ru');
  assert.equal(hasLocale('ru'), true);
  assert.equal(hasLocale('xx'), false);
});

test('setLocale ignores a locale whose chunk has not loaded yet', async () => {
  setLocale('ru');
  setLocale('de');
  assert.equal(getLocale(), 'ru');

  assert.equal(await ensureLocale('de'), 'de');
  setLocale('de');
  assert.equal(getLocale(), 'de');
  assert.equal(t('tabs.folders'), TABLES.de['tabs.folders']);
});

test('t interpolates every placeholder it receives', async () => {
  assert.equal(await ensureLocale('zh-CN'), 'zh-CN');
  setLocale('zh-CN');
  const label = t('common.trackCount', { count: 3 });
  assert.ok(label.includes('3'), label);
  assert.ok(!label.includes('{count}'), label);

  const path = t('error.source.invalidPath', { path: 'a/b.mp3' });
  assert.ok(path.includes('a/b.mp3'), path);
});

test('a missing key falls back to itself and warns once', () => {
  setLocale('en');
  const warnings = [];
  const original = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    assert.equal(t('definitely.missing.key'), 'definitely.missing.key');
    assert.equal(t('definitely.missing.key'), 'definitely.missing.key');
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1);
});
