import test from 'node:test';
import assert from 'node:assert/strict';

import { BATTERY_BRANDS, BATTERY_STEP_KEYS, batteryTarget } from '../src/core/battery.js';

test('batteryTarget prefers the UA-CH model over the UA string', () => {
  const cases = [
    ['SM-S918B', 'samsung'],
    ['M2101K9G', 'xiaomi'],
    ['ELS-NX9', 'huawei'],
    ['Pixel 8', 'stock'],
  ];
  for (const [model, expected] of cases) {
    assert.equal(
      batteryTarget({ model, userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/120' }),
      expected,
      model,
    );
  }
});

test('batteryTarget recognises more model families', () => {
  const cases = [
    ['SM-G991B', 'samsung'],
    ['SAMSUNG SM-A546B', 'samsung'],
    ['2211133C', 'xiaomi'],
    ['POCO F5', 'xiaomi'],
    ['Redmi Note 12', 'xiaomi'],
    ['MI 11', 'xiaomi'],
    ['ANA-AN00', 'huawei'],
    ['NOH-NX9', 'huawei'],
    ['ALN-AL00', 'huawei'],
  ];
  for (const [model, expected] of cases) {
    assert.equal(batteryTarget({ model }), expected, model);
  }
});

test('batteryTarget falls back to UA keywords when the model is absent or unknown', () => {
  const cases = [
    ['Mozilla/5.0 (Linux; Android 13) SamsungBrowser/23.0', 'samsung'],
    ['Mozilla/5.0 (Linux; Android 13) SM-A536B', 'samsung'],
    ['Mozilla/5.0 (Linux; Android 13) MiuiBrowser/17.0', 'xiaomi'],
    ['Mozilla/5.0 (Linux; Android 13) XiaoMi/MiuiBrowser', 'xiaomi'],
    ['Mozilla/5.0 (Linux; Android 13) Redmi Note', 'xiaomi'],
    ['Mozilla/5.0 (Linux; Android 13) HyperOS', 'xiaomi'],
    ['Mozilla/5.0 (Linux; Android 13) HuaweiBrowser/14.0', 'huawei'],
    ['Mozilla/5.0 (Linux; Android 13) EMUI/12', 'huawei'],
    ['Mozilla/5.0 (Linux; Android 13) HarmonyOS', 'huawei'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120', 'stock'],
    ['Mozilla/5.0 (X11; Linux x86_64) Chrome/120', 'stock'],
  ];
  for (const [userAgent, expected] of cases) {
    assert.equal(batteryTarget({ userAgent }), expected, userAgent);
  }
  assert.equal(batteryTarget({ model: 'Unknown', userAgent: 'SamsungBrowser/23.0' }), 'samsung');
});

test('batteryTarget defaults to stock for empty input', () => {
  assert.equal(batteryTarget(), 'stock');
  assert.equal(batteryTarget({}), 'stock');
  assert.equal(batteryTarget({ userAgent: '', model: '' }), 'stock');
});

test('BATTERY_STEP_KEYS has exactly three settings keys per brand', () => {
  assert.deepEqual(Object.keys(BATTERY_STEP_KEYS).sort(), [...BATTERY_BRANDS].sort());
  for (const brand of BATTERY_BRANDS) {
    const keys = BATTERY_STEP_KEYS[brand];
    assert.equal(keys.length, 3, brand);
    for (const key of keys) {
      assert.match(key, /^settings\.background\./, `${brand}: ${key}`);
    }
  }
});
