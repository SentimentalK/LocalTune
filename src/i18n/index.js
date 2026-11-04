/**
 * Tiny runtime string table. Pure module: importing it never touches the DOM
 * (document access is guarded), so Node tests can use it directly.
 *
 * Resolution: explicit setting → navigator languages → 'en'. A missing key in
 * the active table falls back to English, then to the key itself (warned once).
 */

import en from './en.js';
import zhCN from './zh-CN.js';
import zhTW from './zh-TW.js';
import ja from './ja.js';

export const LOCALES = ['zh-CN', 'zh-TW', 'ja', 'en'];

const TABLES = {
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  ja,
  en,
};

const warned = new Set();

function navigatorLanguages() {
  if (typeof navigator === 'undefined') return [];
  const languages = navigator.languages ?? [navigator.language];
  return Array.isArray(languages) ? languages : [languages];
}

/** First entry of a BCP 47 language list that maps to a supported locale. */
export function resolveLocale(languages = []) {
  const list = Array.isArray(languages) ? languages : [languages];
  for (const raw of list) {
    if (typeof raw !== 'string' || !raw) continue;
    const value = raw.toLowerCase();
    if (value === 'zh-tw' || value === 'zh-hk' || value.startsWith('zh-hant')) return 'zh-TW';
    if (value.startsWith('zh')) return 'zh-CN';
    if (value.startsWith('ja')) return 'ja';
  }
  return 'en';
}

/** Explicit setting wins; 'auto' and unknown values follow the browser. */
export function resolveLanguage(setting, languages = []) {
  if (LOCALES.includes(setting)) return setting;
  return resolveLocale(languages);
}

let locale = resolveLocale(navigatorLanguages());

export function getLocale() {
  return locale;
}

/** @param {string} next one of LOCALES; anything else is ignored. */
export function setLocale(next) {
  if (!LOCALES.includes(next)) return;
  locale = next;
}

export function t(key, params = {}) {
  const table = TABLES[locale] ?? en;
  let template = table[key];
  if (typeof template !== 'string') {
    template = en[key];
    if (typeof template !== 'string') {
      if (!warned.has(key)) {
        warned.add(key);
        console.warn(`[i18n] missing key: ${key}`);
      }
      return key;
    }
  }
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}

export function applyDocumentLang() {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = getLocale();
}
