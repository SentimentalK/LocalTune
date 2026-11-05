/**
 * Build-time feature flags. `scripts/build.mjs` defines `__LYRICS_ENABLED__` as
 * a literal, so esbuild folds the guard and drops the lyrics UI from the
 * bundle. Node unit tests import this module directly, where the identifier is
 * absent: the `typeof` check keeps that from throwing and reports `false`.
 */
export const LYRICS_ENABLED =
  typeof __LYRICS_ENABLED__ === 'undefined' ? false : Boolean(__LYRICS_ENABLED__);
