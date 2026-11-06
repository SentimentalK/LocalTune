/**
 * Shared browser-side PKCE (RFC 7636) helpers.
 *
 * Pure logic over WebCrypto: no DOM, no storage, no UI. Used by the OneDrive
 * and Dropbox authorization flows; callers own the redirect, state persistence
 * and token storage.
 */

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Unpadded base64url of a byte array.
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {string}
 */
export function base64UrlEncode(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  for (let i = 0; i < view.length; i += 3) {
    const b0 = view[i];
    const b1 = i + 1 < view.length ? view[i + 1] : 0;
    const b2 = i + 2 < view.length ? view[i + 2] : 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    out += BASE64URL_ALPHABET[(triple >> 18) & 63];
    out += BASE64URL_ALPHABET[(triple >> 12) & 63];
    if (i + 1 < view.length) out += BASE64URL_ALPHABET[(triple >> 6) & 63];
    if (i + 2 < view.length) out += BASE64URL_ALPHABET[triple & 63];
  }
  return out;
}

/**
 * Random PKCE verifier: `randomBytes` random bytes, base64url encoded.
 * @param {number} [randomBytes]
 * @returns {string}
 */
export function createCodeVerifier(randomBytes = 32) {
  const bytes = new Uint8Array(randomBytes);
  globalThis.crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/**
 * S256 challenge: base64url(sha256(utf8(verifier))).
 * @param {string} verifier
 * @returns {Promise<string>}
 */
export async function codeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

/**
 * Opaque CSRF state value.
 * @returns {string}
 */
export function randomState() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/**
 * Parse `location.search` (or a bare query string) after the redirect.
 * @param {string} search
 * @returns {{ code: string|null, state: string|null, error: string|null, errorDescription: string|null }}
 */
export function parseAuthResponse(search) {
  const query = search.startsWith('?') ? search.slice(1) : search;
  const params = new URLSearchParams(query);
  return {
    code: params.get('code'),
    state: params.get('state'),
    error: params.get('error'),
    errorDescription: params.get('error_description'),
  };
}
