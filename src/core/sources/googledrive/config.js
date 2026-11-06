/**
 * Google Drive constants and build-time client ID.
 *
 * The client ID reaches the bundle through esbuild's `define` (see
 * `scripts/build.mjs`): `__GOOGLE_CLIENT_ID__` is replaced by a string literal
 * at build time. The `typeof` guard keeps this module importable from Node
 * tests, where the identifier does not exist.
 */

export const GIS_SRC = 'https://accounts.google.com/gsi/client';
export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
export const TOKEN_SKEW_MS = 60_000;

/**
 * Client ID of the Google OAuth web application. A runtime override on
 * `globalThis` wins (tests, diagnostics), otherwise the build-time value.
 * @returns {string}
 */
export function googleClientId() {
  const override = globalThis.__LT_GOOGLE_CLIENT_ID__;
  if (typeof override === 'string') return override;
  return typeof __GOOGLE_CLIENT_ID__ === 'string' ? __GOOGLE_CLIENT_ID__ : '';
}

/**
 * Whether a client ID is usable: present and not blank.
 * @param {string} [clientId]
 * @returns {boolean}
 */
export function isConfigured(clientId = googleClientId()) {
  return typeof clientId === 'string' && clientId.trim() !== '';
}
