/**
 * Tiny runtime string table. Pure module: importing it never touches the DOM
 * (document access is guarded), so Node tests can use it directly.
 *
 * English is the only statically imported table (first-paint fallback); every
 * other locale is a lazy `import()` chunk loaded on boot, on an explicit pick,
 * or by `languagechange` while the setting is `auto`.
 *
 * Resolution: explicit setting → navigator languages → 'en'. A missing key in
 * the active table falls back to English, then to the key itself (warned once).
 */

import en from './en.js';

export const LOCALES = [
  'zh-CN',
  'zh-TW',
  'ja',
  'en',
  'ko',
  'es',
  'fr',
  'de',
  'pt-BR',
  'ru',
];

export const LOCALE_LABELS = {
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

const LOADERS = {
  'zh-CN': () => import('./zh-CN.js'),
  'zh-TW': () => import('./zh-TW.js'),
  ja: () => import('./ja.js'),
  ko: () => import('./ko.js'),
  es: () => import('./es.js'),
  fr: () => import('./fr.js'),
  de: () => import('./de.js'),
  'pt-BR': () => import('./pt-BR.js'),
  ru: () => import('./ru.js'),
};

const TABLES = { en };
/** In-flight load per locale, so concurrent callers share one chunk request. */
const loading = new Map();

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
    if (value.startsWith('zh-hant') || value === 'zh-tw' || value === 'zh-hk') return 'zh-TW';
    if (value.startsWith('zh')) return 'zh-CN';
    if (value.startsWith('ja')) return 'ja';
    if (value.startsWith('ko')) return 'ko';
    if (value.startsWith('es')) return 'es';
    if (value.startsWith('fr')) return 'fr';
    if (value.startsWith('de')) return 'de';
    if (value.startsWith('pt')) return 'pt-BR';
    if (value.startsWith('ru')) return 'ru';
  }
  return 'en';
}

/** Explicit setting wins; 'auto' and unknown values follow the browser. */
export function resolveLanguage(setting, languages = []) {
  if (LOCALES.includes(setting)) return setting;
  return resolveLocale(languages);
}

export function localeLabel(next) {
  return LOCALE_LABELS[next] ?? LOCALE_LABELS.en;
}

/** The language the browser asks for, with its display label. */
export function systemLocale(languages = navigatorLanguages()) {
  const locale = resolveLocale(languages);
  return { locale, label: localeLabel(locale) };
}

/** True once the table for `next` is resident. */
export function hasLocale(next) {
  return Object.hasOwn(TABLES, next);
}

/**
 * Load the chunk for `next` (idempotent, one in-flight request per locale).
 * Falls back to 'en' for unknown locales or a failed chunk.
 */
export async function ensureLocale(next) {
  if (next === 'en' || !LOCALES.includes(next)) return 'en';
  if (Object.hasOwn(TABLES, next)) return next;
  let promise = loading.get(next);
  if (!promise) {
    promise = Promise.resolve()
      .then(LOADERS[next])
      .then((mod) => {
        TABLES[next] = mod.default;
        return next;
      });
    loading.set(next, promise);
  }
  try {
    return await promise;
  } catch {
    return 'en';
  } finally {
    // A failed chunk may be retried later; a resolved one stays cached.
    if (!Object.hasOwn(TABLES, next)) loading.delete(next);
  }
}

let locale = resolveLocale(navigatorLanguages());

export function getLocale() {
  return locale;
}

/** @param {string} next one of LOCALES with a loaded table; anything else is ignored. */
export function setLocale(next) {
  if (!Object.hasOwn(TABLES, next)) return;
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
