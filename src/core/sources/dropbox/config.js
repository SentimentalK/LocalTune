/**
 * Dropbox constants and build-time app key.
 *
 * The app key reaches the bundle through esbuild's `define` (see
 * `scripts/build.mjs`): `__DROPBOX_APP_KEY__` is replaced by a string literal
 * at build time. The `typeof` guard keeps this module importable from Node
 * tests, where the identifier does not exist.
 */

export const DROPBOX_AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize';
export const DROPBOX_TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
export const DROPBOX_RPC_URL = 'https://api.dropboxapi.com/2';
export const DROPBOX_CONTENT_URL = 'https://content.dropboxapi.com/2';
export const DROPBOX_SCOPES = 'files.metadata.read files.content.read';
export const TOKEN_SKEW_MS = 60_000;

/**
 * App key of the Dropbox app. A runtime override on `globalThis` wins (tests),
 * otherwise the build-time value.
 * @returns {string}
 */
export function dropboxAppKey() {
  const override = globalThis.__LT_DROPBOX_APP_KEY__;
  if (typeof override === 'string') return override;
  return typeof __DROPBOX_APP_KEY__ === 'string' ? __DROPBOX_APP_KEY__ : '';
}

/**
 * Whether an app key is usable: present and not blank.
 * @param {string} [appKey]
 * @returns {boolean}
 */
export function isConfigured(appKey = dropboxAppKey()) {
  return typeof appKey === 'string' && appKey.trim() !== '';
}
