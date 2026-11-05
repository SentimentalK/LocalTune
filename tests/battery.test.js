import test from 'node:test';
import assert from 'node:assert/strict';

import { GUIDE_DIALOG_KEYS, GUIDE_SECTIONS } from '../src/ui/batteryGuide.js';
import en from '../src/i18n/en.js';
import zhCN from '../src/i18n/zh-CN.js';
import zhTW from '../src/i18n/zh-TW.js';
import ja from '../src/i18n/ja.js';

const TABLES = { en, 'zh-CN': zhCN, 'zh-TW': zhTW, ja };
const OEM = /Samsung|Xiaomi|Huawei|MIUI|One UI|EMUI|HyperOS|POCO|Redmi/i;
const allKeys = [
  ...GUIDE_DIALOG_KEYS,
  ...Object.values(GUIDE_SECTIONS).flatMap((section) => [
    ...section.must,
    ...section.should,
    ...section.note,
  ]),
];

test('the guide has two must, two should and two note steps per platform', () => {
  assert.deepEqual(Object.keys(GUIDE_SECTIONS).sort(), ['android', 'ios']);
  for (const [platform, section] of Object.entries(GUIDE_SECTIONS)) {
    assert.equal(section.must.length, 2, `${platform} must`);
    assert.equal(section.should.length, 2, `${platform} should`);
    assert.equal(section.note.length, 2, `${platform} note`);
  }
});

test('every guide key is translated in all four locales and names no OEM', () => {
  for (const [locale, table] of Object.entries(TABLES)) {
    for (const key of allKeys) {
      assert.ok(key in table, `${locale} is missing ${key}`);
      assert.notEqual(table[key], key, `${locale} falls back to the key for ${key}`);
      assert.ok(String(table[key]).trim().length > 0, `${locale} has an empty value for ${key}`);
      assert.ok(!OEM.test(table[key]), `${locale} mentions an OEM in ${key}`);
    }
  }
});

test('every guide key is unique across the sections', () => {
  assert.equal(new Set(allKeys).size, allKeys.length);
});
