import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LOCALES,
  applyDocumentLang,
  getLocale,
  resolveLanguage,
  resolveLocale,
  setLocale,
  t,
} from '../src/i18n/index.js';
import en from '../src/i18n/en.js';
import zhCN from '../src/i18n/zh-CN.js';
import zhTW from '../src/i18n/zh-TW.js';
import ja from '../src/i18n/ja.js';

const TABLES = { 'zh-CN': zhCN, 'zh-TW': zhTW, ja, en };

test('resolveLocale maps the browser language list in order', () => {
  const cases = [
    [['zh-TW'], 'zh-TW'],
    [['zh-HK'], 'zh-TW'],
    [['zh-Hant-TW'], 'zh-TW'],
    [['zh-CN'], 'zh-CN'],
    [['zh'], 'zh-CN'],
    [['ja-JP'], 'ja'],
    [['en-US'], 'en'],
    [['fr-FR', 'ja-JP'], 'ja'],
    [['fr-FR'], 'en'],
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
  assert.equal(resolveLanguage('klingon', ['ja-JP']), 'ja');
  assert.equal(resolveLanguage(null, ['zh-TW']), 'zh-TW');
});

test('every locale defines exactly the same keys', () => {
  const expected = Object.keys(en).sort();
  for (const locale of LOCALES) {
    assert.deepEqual(Object.keys(TABLES[locale]).sort(), expected, locale);
  }
});

test('setLocale switches the active table and ignores unknown locales', () => {
  const before = getLocale();
  setLocale('ja');
  assert.equal(getLocale(), 'ja');
  assert.equal(t('tabs.tracks'), ja['tabs.tracks']);
  assert.equal(t('common.ready'), ja['common.ready']);

  setLocale('zh-CN');
  assert.equal(getLocale(), 'zh-CN');
  assert.equal(t('tabs.tracks'), zhCN['tabs.tracks']);

  setLocale('de');
  assert.equal(getLocale(), 'zh-CN');

  setLocale(before);
});

test('t interpolates every placeholder it receives', () => {
  setLocale('zh-CN');
  const label = t('common.trackCount', { count: 3 });
  assert.ok(label.includes('3'), label);
  assert.ok(!label.includes('{count}'), label);

  const path = t('error.source.invalidPath', { path: 'a/b.mp3' });
  assert.ok(path.includes('a/b.mp3'), path);
});

test('a missing key falls back to itself and warns once', () => {
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

test('applyDocumentLang is a no-op without a document', () => {
  assert.equal(typeof document, 'undefined');
  assert.doesNotThrow(() => applyDocumentLang());
});
