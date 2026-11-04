import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultLocalMode } from '../src/core/sources/opfs/mode.js';

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36';
const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';

test('defaultLocalMode imports on Android even with a directory picker', () => {
  assert.equal(defaultLocalMode({ userAgent: ANDROID_UA, hasPicker: true }), 'import');
});

test('defaultLocalMode imports when the browser has no directory picker', () => {
  assert.equal(defaultLocalMode({ userAgent: DESKTOP_UA, hasPicker: false }), 'import');
});

test('defaultLocalMode references the folder on desktop Chromium', () => {
  assert.equal(defaultLocalMode({ userAgent: DESKTOP_UA, hasPicker: true }), 'reference');
});

test('defaultLocalMode imports with no arguments', () => {
  assert.equal(defaultLocalMode(), 'import');
});
