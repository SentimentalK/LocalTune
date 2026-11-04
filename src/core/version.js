/**
 * Build version injected by esbuild's `define` at bundle time. Outside a build
 * (tests, node scripts) `typeof` keeps the bare identifier from throwing.
 */
export const BUILD_VERSION = typeof __BUILD_VERSION__ === 'string' ? __BUILD_VERSION__ : 'dev';
