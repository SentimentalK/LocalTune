import test from 'node:test';
import assert from 'node:assert/strict';

import { BATTERY_BRANDS, BATTERY_STEP_KEYS } from '../src/core/battery.js';
import en from '../src/i18n/en.js';
import zhCN from '../src/i18n/zh-CN.js';
import zhTW from '../src/i18n/zh-TW.js';
import ja from '../src/i18n/ja.js';

const TABLES = { en, 'zh-CN': zhCN, 'zh-TW': zhTW, ja };

test('BATTERY_STEP_KEYS covers every brand with exactly three steps', () => {
  assert.deepEqual(Object.keys(BATTERY_STEP_KEYS).sort(), [...BATTERY_BRANDS].sort());
  for (const brand of BATTERY_BRANDS) {
    const keys = BATTERY_STEP_KEYS[brand];
    assert.equal(keys.length, 3, brand);
    for (const key of keys) {
      assert.match(key, /^settings\.background\./, `${brand}: ${key}`);
    }
  }
});

test('every battery step key is translated in all four locales', () => {
  const keys = Object.values(BATTERY_STEP_KEYS).flat();
  for (const [locale, table] of Object.entries(TABLES)) {
    for (const key of keys) {
      assert.ok(key in table, `${locale} is missing ${key}`);
      assert.notEqual(table[key], key, `${locale} falls back to the key for ${key}`);
      assert.ok(table[key].trim().length > 0, `${locale} has an empty value for ${key}`);
    }
  }
});
